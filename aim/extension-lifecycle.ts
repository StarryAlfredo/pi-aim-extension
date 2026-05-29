/**
 * AIM — Extension Lifecycle
 *
 * Centralizes all cross-module callback registration (wiring),
 * lead poller management, permission handling, and periodic cleanup.
 * Extracted from index.ts to separate lifecycle concerns from tool registration.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerFindCandidateAgent, registerIsAgentBusy, updateTask, getTask, cleanupStaleTasks } from "./shared-tasks.js";
import { findLeastBusyAgent, isAgentBusyStatus } from "./agent-status.js";
import { registerMarkNudgeSent } from "./task-notifications.js";
import { startLeadPoller, type PermissionRequestHandler } from "./lead-poller.js";
import { getActiveTeam } from "./teams.js";
import { onTransition as onDisplayTransition, onEvict, removeDisplayState, cleanupCompletedDisplayStates } from "./task-foreground.js";
import { progressTracker, removeProgressTracker, deletePersistedProgress, cleanupStaleProgress, getProgressTracker, generateCompactSummary } from "./task-progress.js";
import { cleanupResultFiles } from "./task-result-storage.js";

// ============================================================================
// Callback Wiring
// ============================================================================

/**
 * Register all cross-module callbacks to break circular dependencies.
 * Called once during extension initialization (first thing in index.ts).
 *
 * Circular dependencies resolved:
 *
 * 1. shared-tasks.ts ↔ agent-status.ts
 *    - shared-tasks needs findLeastBusyAgent (from agent-status) for unblocked task notification
 *    - shared-tasks needs isAgentBusyStatus (from agent-status) for claimTask busy check
 *    → Resolved via: registerFindCandidateAgent, registerIsAgentBusy
 *
 * 2. task-notifications.ts ↔ shared-tasks.ts
 *    - task-notifications needs updateTask (from shared-tasks) to mark nudgeSent on tasks
 *    → Resolved via: registerMarkNudgeSent
 *
 * To add new wiring: register the callback here, add a comment explaining the cycle.
 */
export function wireCallbacks(_pi: ExtensionAPI): void {
  // Break circular dep: shared-tasks.ts ↔ agent-status.ts
  registerFindCandidateAgent((cwd, team) => findLeastBusyAgent(cwd, team)?.agentId);
  registerIsAgentBusy((cwd, team, agentName) => isAgentBusyStatus(cwd, team, agentName));

  // Break circular dep: task-notifications.ts ↔ shared-tasks.ts
  registerMarkNudgeSent(async (cwd, team, taskId) => {
    const task = getTask(cwd, team, taskId);
    if (task) {
      await updateTask(cwd, team, taskId, {
        metadata: { ...task.metadata, verificationNudgeSent: true },
      });
    }
  });
}

// ============================================================================
// Permission Handler
// ============================================================================

/** Dangerous command patterns that must never be auto-approved */
const DANGEROUS_COMMAND_PATTERNS = /rm\s+-[a-zA-Z]*f|sudo\s|mkfs|dd\s+if|format\s|del\s+\/[sS]|\bchmod\s+777|\bchown\s+root|>\s*\/dev\/sd/i;

/**
 * Create the permission request handler for the lead poller.
 * Bridges the mailbox-based permission system with pi's UI.
 */
export function createPermissionHandler(pi: ExtensionAPI): PermissionRequestHandler {
  return async (requestId, agentName, toolName, toolArgs) => {
    try {
      const commandStr = typeof toolArgs.command === "string"
        ? toolArgs.command
        : JSON.stringify(toolArgs);
      const summary = commandStr.slice(0, 80);

      // Block dangerous commands automatically
      if (DANGEROUS_COMMAND_PATTERNS.test(commandStr)) {
        pi.sendMessage({
          role: "user",
          content: `🔐 ⛔ Permission DENIED from ${agentName}: ${toolName}(${summary}) — dangerous command blocked.`,
        });
        return { approved: false, reason: "Dangerous command blocked by safety filter" };
      }

      pi.sendMessage({
        role: "user",
        content: `🔐 Permission request from ${agentName}: ${toolName}(${summary})`,
      });

      // Default deny: without a full ToolUseConfirm integration, we cannot
      // safely auto-approve arbitrary commands.
      pi.sendMessage({
        role: "user",
        content: `🔐 Permission DENIED from ${agentName}: ${toolName}(${summary}) — auto-approve disabled for safety. Implement ToolUseConfirm integration for interactive approval.`,
      });
      return { approved: false, reason: "Auto-approve disabled for safety. Implement ToolUseConfirm integration for interactive approval." };
    } catch {
      return { approved: false, reason: "Failed to present permission request to user" };
    }
  };
}

// ============================================================================
// Lifecycle Services
// ============================================================================

/**
 * Start all lifecycle services: lead poller, stale task cleanup,
 * display transition callbacks, and periodic cleanup timers.
 *
 * Returns a cleanup function that stops all services when called.
 */
export function startLifecycleServices(pi: ExtensionAPI): () => void {
  const cleanupHandles: Array<() => void> = [];

  // ── Lead poller ──
  let leadPollerController: AbortController | null = null;

  const startLeadPollerForTeam = (teamName: string, cwd: string) => {
    if (leadPollerController) {
      leadPollerController.abort();
    }
    leadPollerController = new AbortController();

    startLeadPoller({
      cwd,
      teamName,
      signal: leadPollerController.signal,
      onPermissionRequest: createPermissionHandler(pi),
      onDistribution: (result) => {
        if (result.assigned) {
          pi.sendMessage({
            role: "user",
            content: `📋 Task #${result.taskId} assigned to ${result.agentName}`,
          });
        }
      },
    }).catch(err => {
      if (!(err instanceof Error && err.message.includes("aborted"))) {
        console.warn("[aim] Lead poller error:", err);
      }
    });

    // Stale task cleanup for this team
    const cleanup = startStaleTaskCleanup(teamName, cwd);
    cleanupHandles.push(cleanup);
  };

  // Auto-start lead poller if a team is already active
  const activeTeam = getActiveTeam();
  if (activeTeam) {
    startLeadPollerForTeam(activeTeam.name, process.cwd());
  }

  cleanupHandles.push(() => {
    if (leadPollerController) leadPollerController.abort();
  });

  // ── Display transition callbacks ──
  onDisplayTransition((id, isFg) => {
    if (!isFg) {
      const progress = getProgressTracker(id);
      const status = progress ? generateCompactSummary(id) : "running";
      pi.sendMessage({
        role: "user",
        content: `⏸️ Task ${id} moved to background (${status})`,
      });
    }
  });

  onEvict((id) => {
    removeProgressTracker(id);
    deletePersistedProgress(process.cwd(), id);
  });

  // ── Periodic cleanup (5 min interval) ──
  const periodicCleanupTimer = setInterval(() => {
    import("./task-progress.js").then(({ progressTracker: tracker }) => {
      const progressCleaned = tracker.cleanupStale();
      const displayCleaned = cleanupCompletedDisplayStates();
      const resultFilesCleaned = cleanupResultFiles(process.cwd());
      if (progressCleaned > 0 || displayCleaned > 0 || resultFilesCleaned > 0) {
        console.info(`[aim] Cleanup: ${progressCleaned} stale progress, ${displayCleaned} display states, ${resultFilesCleaned} result files removed`);
      }
    });
  }, 300_000);
  cleanupHandles.push(() => clearInterval(periodicCleanupTimer));

  // Return cleanup function
  return () => {
    for (const cleanup of cleanupHandles) {
      try { cleanup(); } catch {}
    }
  };
}

// ============================================================================
// Stale Task Cleanup
// ============================================================================

function startStaleTaskCleanup(teamName: string, cwd: string): () => void {
  const interval = setInterval(async () => {
    try {
      const cleaned = await cleanupStaleTasks(cwd, teamName);
      if (cleaned > 0) {
        console.info(`[aim] Cleaned up ${cleaned} stale tasks`);
      }
    } catch (err) {
      console.warn("[aim] Stale task cleanup failed:", err);
    }
  }, 600_000); // 10 minutes

  return () => clearInterval(interval);
}
