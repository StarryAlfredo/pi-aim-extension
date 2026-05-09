/**
 * AIM — Inbox Poller (P2 enhanced)
 *
 * Continuous polling loop for long-lived agents. Used by teammates
 * to wait for new prompts, shutdown requests, or available tasks.
 *
 * Priority:
 *   1. Shutdown requests       (highest — always respond first)
 *   2. Team-lead messages       (leader coordination)
 *   3. Peer messages            (other workers)
 *   4. Task list claim          (available tasks)
 *
 * P2 additions:
 *   - Structured message parsing (shutdown_request, plan_approval)
 *   - Task list polling and claiming
 *   - Idle notification to leader
 */

import { readUnreadMessages, markMessageAsRead, parseStructuredMessage } from "./mailbox.js";
import { writeToMailbox, createIdleNotification } from "./mailbox.js";
import { findAvailableTask, claimTask, findUnblockedTasks, listTasks, isTerminalStatus } from "./shared-tasks.js";
import { findLeastBusyAgent, isAgentBusyStatus, type AgentStatus } from "./agent-status.js";
import { notifyTaskAssignment, notifyTaskUnblocked, nudgeVerification, type TaskNotification } from "./task-notifications.js";

// ============================================================================
// Types
// ============================================================================



export type PollResult =
  | { type: "shutdown_request"; request: { requestId: string; from: string; reason?: string }; original: string }
  | { type: "new_message"; message: string; from: string; isStructured: boolean; structured?: ReturnType<typeof parseStructuredMessage> }
  | { type: "task_claimed"; taskId: string; subject: string; prompt: string }
  | { type: "task_notification"; notification: TaskNotification; raw: string }
  | { type: "task_unblocked"; taskId: string; unblockedBy: string; availableTasks: import("./shared-tasks.js").TaskItem[] }
  | { type: "aborted" };

// ============================================================================
// Main Poller
// ============================================================================

/**
 * Blocking poll loop — waits for inbox messages, shutdown signal, or available tasks.
 * Returns when something is found or the signal is aborted.
 */
export async function pollInbox(
  cwd: string,
  agentName: string,
  teamName: string,
  signal: AbortSignal,
): Promise<PollResult> {
  const POLL_INTERVAL_MS = 500;
  // Track tasks we failed to claim to avoid tight retry loops
  const skippedTaskIds = new Set<string>();
  let skipClearCounter = 0;

  while (!signal.aborted) {
    const unread = await readUnreadMessages(cwd, agentName, teamName);

    // --- Priority 1: Shutdown requests ---
    let shutdownIdx = -1;
    let shutdownParsed: ReturnType<typeof parseStructuredMessage> | null = null;
    for (let i = 0; i < unread.length; i++) {
      const msg = unread[i];
      if (!msg) continue;
      const parsed = parseStructuredMessage(msg.text);
      if (parsed.kind === "shutdown_request") {
        shutdownIdx = i;
        shutdownParsed = parsed;
        break;
      }
    }

    if (shutdownIdx !== -1 && shutdownParsed?.kind === "shutdown_request") {
      const msg = unread[shutdownIdx]!;
      await markMessageAsRead(cwd, agentName, teamName, shutdownIdx);
      return {
        type: "shutdown_request",
        request: {
          requestId: shutdownParsed.requestId,
          from: shutdownParsed.from,
          reason: shutdownParsed.reason,
        },
        original: msg.text,
      };
    }

    // --- Priority 2: Team-lead messages ---
    let leadIdx = -1;
    for (let i = 0; i < unread.length; i++) {
      if (unread[i]?.from === "team-lead") { leadIdx = i; break; }
    }
    if (leadIdx !== -1) {
      const msg = unread[leadIdx]!;
      const parsed = parseStructuredMessage(msg.text);
      await markMessageAsRead(cwd, agentName, teamName, leadIdx);
      return { type: "new_message", message: msg.text, from: msg.from, isStructured: parsed.kind !== "plain_text", structured: parsed };
    }

    // --- Priority 2.5: Task system notifications ---
    // Check if any unread message is a task notification from the task-system sender.
    // These are higher priority than regular messages because they may indicate
    // a task assignment or unblocking event that the agent should act on immediately.
    for (let i = 0; i < unread.length; i++) {
      const msg = unread[i];
      if (!msg || msg.from !== "task-system") continue;
      try {
        const notif = JSON.parse(msg.text) as TaskNotification;
        if (notif.type === "task_assigned" || notif.type === "task_unblocked") {
          await markMessageAsRead(cwd, agentName, teamName, i);
          // For task_assigned: the agent has been assigned a specific task — claim it directly.
          // Use the taskId from the notification rather than re-searching, since the
          // assignment is intentional (from team-lead or auto-distributor).
          if (notif.type === "task_assigned") {
            // task_assigned means the task was already assigned (status=in_progress, owner set)
            // by the assigner — no need to call claimTask again (it would reject since the
            // task is no longer pending). If we are the assignee, build the prompt directly.
            if (!isAgentBusyStatus(cwd, teamName, agentName)) {
              const task = getTask(cwd, teamName, notif.taskId);
              if (task && task.owner === agentName && task.status === "in_progress") {
                const prompt = `Complete task #${task.id}: ${task.subject}\n\n${task.description || ""}`;
                return { type: "task_claimed", taskId: task.id, subject: task.subject, prompt };
              }
            }
            // Task assigned to someone else or no longer actionable — skip
          }
          // For task_unblocked: a task that was blocked is now unblocked
          if (notif.type === "task_unblocked" && !isAgentBusyStatus(cwd, teamName, agentName)) {
            const unblocked = findUnblockedTasks(cwd, teamName, notif.unblockedBy);
            if (unblocked.length > 0) {
              const toClaim = unblocked.find(t => !t.owner);
              if (toClaim) {
                const result = await claimTask(cwd, teamName, toClaim.id, agentName);
                if ("task" in result) {
                  const prompt = `Complete task #${result.task.id}: ${result.task.subject}\n\n${result.task.description || ""}`;
                  return { type: "task_claimed", taskId: result.task.id, subject: result.task.subject, prompt };
                }
              }
            }
          }
          // Fall through: notification handled but no task to claim
          return { type: "task_notification", notification: notif, raw: msg.text };
        }
        if (notif.type === "verification_nudge") {
          await markMessageAsRead(cwd, agentName, teamName, i);
          return { type: "task_notification", notification: notif, raw: msg.text };
        }
        // Handle task_completed and task_failed notifications so they don't
        // block the inbox (they are informational — no action needed by the
        // agent, but must be marked as read to prevent infinite re-discovery).
        if (notif.type === "task_completed" || notif.type === "task_failed") {
          await markMessageAsRead(cwd, agentName, teamName, i);
          return { type: "task_notification", notification: notif, raw: msg.text };
        }
      } catch {
        // Not valid JSON or not a task notification — skip
      }
    }

    // --- Priority 3: Peer messages (exclude task-system) ---
    let peerIdx = -1;
    for (let i = 0; i < unread.length; i++) {
      if (unread[i]?.from !== "team-lead" && unread[i]?.from !== "task-system") { peerIdx = i; break; }
    }
    if (peerIdx !== -1) {
      const msg = unread[peerIdx]!;
      const parsed = parseStructuredMessage(msg.text);
      await markMessageAsRead(cwd, agentName, teamName, peerIdx);
      return { type: "new_message", message: msg.text, from: msg.from, isStructured: parsed.kind !== "plain_text", structured: parsed };
    }

    // --- Priority 4: Task list claim ---
    if (teamName) {
      const available = findAvailableTask(cwd, teamName);
      if (available) {
        // Skip tasks we already failed to claim due to task-side issues
        // (already claimed by another agent, etc.)
        if (skippedTaskIds.has(available.id)) {
          // Already tried and failed — don't hammer the lock
        } else {
          const result = await claimTask(cwd, teamName, available.id, agentName);
          if ("task" in result) {
            const { task: claimed } = result;
            const prompt = `Complete task #${claimed.id}: ${claimed.subject}\n\n${claimed.description || ""}`;
            return { type: "task_claimed", taskId: claimed.id, subject: claimed.subject, prompt };
          }
          // Distinguish rejection reasons:
          //   - agent_busy: this agent owns another open task — don't skip
          //     the task (it's fine, just not for us right now). Break out
          //     of the task-claim branch so we fall through to idle sleep.
          //   - Other reasons (task already claimed, blocked, etc.): skip
          //     this task to avoid tight retry loops on the same task.
          if ("rejected" in result && result.reason === "agent_busy") {
            // Agent is busy with another task — no point trying other tasks either.
            // Fall through to idle wait; when the current task completes,
            // the next poll cycle will find new work.
          } else {
            // Task-side issue — skip this task for a few cycles
            skippedTaskIds.add(available.id);
          }
        }
        // Claim rejected — possible reasons:
        //   agent_busy: this agent already owns an open task
        //   blocked_by_X: a dependency hasn't completed yet
        //   task_status_is_Y: another agent claimed it first
        // All are non-fatal; will retry on next poll cycle.
      }

      // Periodically clear the skip set to allow retries when conditions change
      // (e.g. a blocker completes, or the agent finishes its current task).
      skipClearCounter++;
      if (skipClearCounter >= 10) { // ~5 seconds at 500ms poll interval
        skippedTaskIds.clear();
        skipClearCounter = 0;
      }
    }

    // Nothing found — wait and retry
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return { type: "aborted" };
}

/**
 * Send an idle notification to the team leader.
 */
export async function sendIdleNotification(
  cwd: string,
  agentName: string,
  teamName: string,
  options?: { idleReason?: "available" | "interrupted" | "failed" | "completed"; summary?: string; completedTaskId?: string },
): Promise<void> {
  const payload = createIdleNotification(agentName, options);
  await writeToMailbox(cwd, "team-lead", {
    from: agentName, text: payload, timestamp: new Date().toISOString(),
  }, teamName);
}

