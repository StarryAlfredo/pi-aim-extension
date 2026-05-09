/**
 * AIM — Lead Inbox Poller
 *
 * Continuous polling loop for the team lead's inbox.
 * Handles messages that only the lead can act on:
 *
 *   1. idle_notification → distribute available tasks to idle agents
 *   2. permission_request → present to user for approval/rejection
 *   3. task_completed / task_failed → informational (already handled by updateTask)
 *   4. verification_nudge → suggest spawning a reviewer
 *   5. task_unblocked → distribute newly available tasks
 *
 * This is the missing piece: teammates have teammate-loop.ts for polling,
 * but the lead had nothing consuming its inbox. Mirrors Claude Code's
 * useInboxPoller React Hook which runs on the lead's REPL session.
 */

import { readUnreadMessages, markMessageAsRead, parseStructuredMessage, writeToMailbox } from "./mailbox.js";
import { handleIdleAgent, distributeAvailableTasks, handleTaskCompleted } from "./task-distributor.js";
import { listTasks, isTerminalStatus } from "./shared-tasks.js";
import type { TaskNotification } from "./task-notifications.js";

// ============================================================================
// Types
// ============================================================================

/** Handler for permission requests from teammates */
export type PermissionRequestHandler = (
  requestId: string,
  agentName: string,
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ approved: boolean; reason?: string }>;

/** Configuration for the lead poller */
export interface LeadPollerConfig {
  /** Working directory */
  cwd: string;
  /** Team name */
  teamName: string;
  /** Lead agent name (typically "team-lead") */
  leadName?: string;
  /** Abort signal for stopping the poller */
  signal: AbortSignal;
  /** Handler for permission requests. If not provided, permission requests
   *  are auto-approved (useful for testing or non-interactive mode). */
  onPermissionRequest?: PermissionRequestHandler;
  /** Called when a task distribution event occurs */
  onDistribution?: (result: import("./task-distributor.js").DistributionResult) => void;
  /** Polling interval in ms (default: 1000) */
  pollIntervalMs?: number;
}

interface LeadPollerState {
  running: boolean;
  lastPollAt: number;
  messagesProcessed: number;
  tasksDistributed: number;
}

// ============================================================================
// Lead Poller
// ============================================================================

/**
 * Start the lead inbox poller.
 *
 * This runs as a background loop that continuously checks the team lead's
 * inbox for messages from teammates. It runs in the lead's main process,
 * NOT in a sub-agent.
 *
 * The poller is designed to be non-blocking: it processes one message per
 * iteration and yields control between iterations, so it doesn't interfere
 * with the lead's normal conversation loop.
 */
export async function startLeadPoller(config: LeadPollerConfig): Promise<void> {
  const {
    cwd,
    teamName,
    leadName = "team-lead",
    signal,
    onPermissionRequest,
    onDistribution,
    pollIntervalMs = 1000,
  } = config;

  const state: LeadPollerState = {
    running: true,
    lastPollAt: 0,
    messagesProcessed: 0,
    tasksDistributed: 0,
  };

  while (!signal.aborted && state.running) {
    state.lastPollAt = Date.now();

    try {
      const unread = await readUnreadMessages(cwd, leadName, teamName);

      for (let i = 0; i < unread.length; i++) {
        if (signal.aborted) break;

        const msg = unread[i];
        if (!msg) continue;

        // Mark as read FIRST to prevent re-processing on next poll cycle.
        // If processing fails, we still won't re-process (at-least-once semantics).
        await markMessageAsRead(cwd, leadName, teamName, i);
        state.messagesProcessed++;

        await processLeadMessage(cwd, teamName, leadName, msg.text, msg.from, config, state);
      }
    } catch (err) {
      // Non-fatal: the lead's main loop should continue even if
      // inbox processing has a transient error.
      console.warn(`[aim:lead-poller] Error processing inbox:`, err);
    }

    // Yield control: wait before next poll cycle.
    // This ensures the poller doesn't block the lead's event loop.
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  state.running = false;
}

// ============================================================================
// Message Processing
// ============================================================================

/**
 * Process a single message in the lead's inbox.
 *
 * Messages are dispatched by type:
 *   - idle_notification → distribute tasks
 *   - permission_request → forward to user
 *   - task_notification → informational / distribution
 *   - structured protocol messages → handled by existing logic
 *   - plain text → log and skip
 */
async function processLeadMessage(
  cwd: string,
  teamName: string,
  leadName: string,
  text: string,
  from: string,
  config: LeadPollerConfig,
  state: LeadPollerState,
): Promise<void> {
  // --- Try structured message parsing first ---
  const structured = parseStructuredMessage(text);
  if (structured.kind !== "plain_text") {
    // Structured protocol messages (shutdown, plan_approval) are handled
    // by the teammate-loop, not the lead poller. Skip them here.
    return;
  }

  // --- Try idle notification (not in TaskNotification type — separate protocol) ---
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.type === "idle_notification") {
      const idleNotif = parsed as {
        type: "idle_notification";
        from: string;
        idleReason?: string;
        summary?: string;
        completedTaskId?: string;
      };

      // If the teammate just completed a task, handle unblocked tasks first
      if (idleNotif.completedTaskId) {
        const count = await handleTaskCompleted(cwd, teamName, idleNotif.completedTaskId);
        state.tasksDistributed += count;
      }

      // Then try to assign the idle agent a new task
      const result = await handleIdleAgent(cwd, teamName, idleNotif.from);
      if (result.assigned) {
        state.tasksDistributed++;
      }
      config.onDistribution?.(result);
      return;
    }
  } catch {
    // Not valid JSON
  }

  // --- Try task notification parsing ---
  try {
    const notif = JSON.parse(text) as TaskNotification;

    switch (notif.type) {
      case "task_assigned": {
        // Informational: a task was assigned. The assignment notification
        // was sent by the task system — no action needed by the lead.
        return;
      }

      case "task_completed": {
        // Informational: a task was completed. The updateTask flow already
        // handles notifications and dependency resolution. But we can
        // try to distribute newly unblocked tasks.
        const count = await handleTaskCompleted(cwd, teamName, notif.taskId);
        state.tasksDistributed += count;
        return;
      }

      case "task_failed": {
        // Informational: failure propagation is handled by shared-tasks.ts.
        // No additional action needed by the lead.
        return;
      }

      case "task_unblocked": {
        // A task was unblocked — try to distribute it to an idle agent.
        const count = await distributeAvailableTasks(cwd, teamName);
        state.tasksDistributed += count;
        return;
      }

      case "verification_nudge": {
        // Suggest spawning a reviewer. Log it — the lead's LLM will
        // see this in its next turn if it reads the conversation.
        console.info(`[aim:lead-poller] Verification nudge: ${notif.message}`);
        return;
      }

      default:
        // Unknown notification type — fall through to plain text handling
        break;
    }
  } catch {
    // Not valid JSON — fall through to plain text handling
  }

  // --- Try permission request ---
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.type === "permission_request") {
      await handlePermissionRequest(cwd, teamName, from, parsed, config);
      return;
    }
  } catch {
    // Not JSON
  }

  // --- Plain text from teammate ---
  // Log it but don't act on it — the lead's conversation loop
  // will handle direct messages from teammates.
  console.info(`[aim:lead-poller] Message from ${from}: ${text.slice(0, 100)}`);
}

// ============================================================================
// Permission Request Handling
// ============================================================================

/**
 * Handle a permission request from a teammate.
 *
 * Flow:
 *   1. Teammate encounters dangerous command
 *   2. Teammate sends permission_request to lead's mailbox
 *   3. Lead polls inbox and finds the request
 *   4. Lead presents the request to the user (via onPermissionRequest callback)
 *   5. User approves/rejects
 *   6. Lead sends permission_response to teammate's mailbox
 *   7. Teammate continues or aborts the command
 */
async function handlePermissionRequest(
  cwd: string,
  teamName: string,
  from: string,
  parsed: Record<string, unknown>,
  config: LeadPollerConfig,
): Promise<void> {
  const requestId = parsed.request_id as string | undefined;
  const toolName = parsed.tool_name as string | undefined;
  const toolArgs = (parsed.tool_args ?? {}) as Record<string, unknown>;

  if (!requestId || !toolName) {
    console.warn(`[aim:lead-poller] Invalid permission request from ${from}: missing request_id or tool_name`);
    return;
  }

  let approved = false;
  let reason: string | undefined;

  if (config.onPermissionRequest) {
    // Interactive mode: forward to user via the callback
    const result = await config.onPermissionRequest(requestId, from, toolName, toolArgs);
    approved = result.approved;
    reason = result.reason;
  } else {
    // Non-interactive mode: auto-DENY for safety.
    // Without a permission handler, dangerous commands must be blocked
    // to prevent unintended execution (rm -rf, sudo, etc.).
    approved = false;
    reason = "No permission handler registered — denied for safety. Register onPermissionRequest callback.";
    console.warn('[aim:lead-poller] WARNING: No onPermissionRequest handler registered. Dangerous command denied by default.');
  }

  // Send response back to the requesting teammate
  await writeToMailbox(cwd, from, {
    from: "team-lead",
    text: JSON.stringify({
      type: "permission_response",
      request_id: requestId,
      subtype: approved ? "success" : "error",
      ...(approved ? {} : { error: reason ?? "Permission denied by team lead" }),
    }),
    timestamp: new Date().toISOString(),
  }, teamName);
}

// ============================================================================
// Utility
// ============================================================================

/**
 * Create a permission request payload for a teammate to send to the lead.
 * Used by permissions.ts when intercepting dangerous commands in teammate processes.
 */
export function createPermissionRequestPayload(
  requestId: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  agentName: string,
): string {
  return JSON.stringify({
    type: "permission_request",
    request_id: requestId,
    from: agentName,
    tool_name: toolName,
    tool_args: toolArgs,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Get the current state of the lead poller (for diagnostics).
 * Note: this is a snapshot — the state may change immediately after reading.
 */
export function getLeadPollerState(poller: { running: boolean; lastPollAt: number; messagesProcessed: number; tasksDistributed: number }): LeadPollerState {
  return { ...poller };
}