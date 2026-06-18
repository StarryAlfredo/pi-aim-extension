/**
 * AIM — Task Notifications (extracted from poller.ts)
 *
 * Handles mailbox-based notifications for task lifecycle events:
 *   - Task unblocked (dependency completed)
 *   - Verification nudge (3+ completed tasks without verification)
 *
 * Extracted from poller.ts to break the circular dependency:
 *   shared-tasks.ts → (dynamic import) → poller.ts → shared-tasks.ts
 * Now both import from this neutral module.
 */

import { writeToMailbox } from "./mailbox.js";
import { isTerminalStatus, type TaskItem } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { getTasksDir } from "./types.js";

// ============================================================================
// Team-Level Nudge State (survives task deletion)
// ============================================================================

const NUDGE_STATE_FILE = ".nudge-state.json";

interface NudgeState {
  /** Whether verification nudge has been sent for this team */
  verificationNudgeSent?: boolean;
  /** Timestamp of the nudge */
  verificationNudgeSentAt?: number;
}

function readNudgeState(cwd: string, teamName: string): NudgeState {
  const fp = path.join(getTasksDir(cwd, teamName), NUDGE_STATE_FILE);
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8")) as NudgeState;
  } catch {
    return {};
  }
}

function writeNudgeState(cwd: string, teamName: string, state: NudgeState): void {
  const dir = getTasksDir(cwd, teamName);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const fp = path.join(dir, NUDGE_STATE_FILE);
  fs.writeFileSync(fp, JSON.stringify(state, null, 2));
}

// ============================================================================
// Callbacks (to break circular dependencies)
// ============================================================================

/** Callback type for marking a task's metadata after nudge is sent.
 *  Registered by the extension entry point (index.ts) to allow
 *  nudgeVerification to update task metadata without importing shared-tasks.ts. */
export type MarkNudgeSentFn = (cwd: string, team: string, taskId: string) => Promise<void>;

let _markNudgeSentFn: MarkNudgeSentFn | null = null;

/** Register a callback to mark verification nudge as sent on a task.
 *  Called by nudgeVerification after sending the nudge notification. */
export function registerMarkNudgeSent(fn: MarkNudgeSentFn): void {
  _markNudgeSentFn = fn;
}

// ============================================================================
// Types
// ============================================================================

/** Task notification types delivered via mailbox */
export type TaskNotification =
  | { type: "task_assigned"; taskId: string; subject: string; assignedBy: string }
  | { type: "task_unblocked"; taskId: string; unblockedBy: string }
  | { type: "task_completed"; taskId: string; completedBy: string }
  | { type: "task_failed"; taskId: string; failedBy: string; reason?: string }
  | { type: "verification_nudge"; message: string };

// ============================================================================
// Notifications
// ============================================================================

/**
 * Send a task unblocked notification when a blocking task reaches terminal state.
 *
 * Uses the completed task's `blocks` field for precise notification — no need
 * to scan all tasks. Only notifies owners of tasks whose ALL blockers are now
 * terminal (i.e. the task is fully unblocked and ready to claim).
 */
export async function notifyTaskUnblocked(
  cwd: string,
  teamName: string,
  completedTaskId: string,
  allTasks: TaskItem[],
  candidateAgent?: string,
): Promise<void> {
  const completedTask = allTasks.find(t => t.id === completedTaskId);
  if (!completedTask || completedTask.blocks.length === 0) return;

  for (const blockedId of completedTask.blocks) {
    const blocked = allTasks.find(t => t.id === blockedId);
    if (!blocked || blocked.status !== "pending") continue;

    // Check if ALL blockers are now terminal (task is fully unblocked)
    const fullyUnblocked = blocked.blockedBy.every(bid => {
      const blocker = allTasks.find(t => t.id === bid);
      // Dangling reference → treat as unblocked (deleteTask should have cleaned up)
      if (!blocker) return true;
      return isTerminalStatus(blocker.status);
    });

    if (!fullyUnblocked) continue;

    // Notify the owner of the now-unblocked task.
    // If the task has no owner (hasn't been claimed yet), notify ALL idle
    // teammates so they can discover and claim the newly-available task.
    // Without this, unowned unblocked tasks would only be found on the next
    // natural poll cycle, delaying assignment.
    if (blocked.owner) {
      const notif: TaskNotification = {
        type: "task_unblocked",
        taskId: blocked.id,
        unblockedBy: completedTaskId,
      };
      await writeToMailbox(cwd, blocked.owner, {
        from: "task-system",
        text: JSON.stringify(notif),
        timestamp: new Date().toISOString(),
      }, teamName);
    } else {
      // No owner — notify a single candidate agent if available.
      // This avoids mailbox storms from broadcasting to all idle agents.
      // The candidate is selected by the caller (e.g. findLeastBusyAgent)
      // and passed as a parameter, breaking the circular dependency on
      // agent-status.ts. If no candidate is provided, only the team-lead
      // is notified (below) and the task will be discovered on the next poll cycle.
      if (candidateAgent) {
        const notif: TaskNotification = {
          type: "task_unblocked",
          taskId: blocked.id,
          unblockedBy: completedTaskId,
        };
        try {
          await writeToMailbox(cwd, candidateAgent, {
            from: "task-system",
            text: JSON.stringify(notif),
            timestamp: new Date().toISOString(),
          }, teamName);
        } catch (err) {
          console.warn(`[aim] Failed to notify candidate agent ${candidateAgent} for task #${blocked.id}:`, err);
        }
      }
    }
  }

  // Also notify the team leader so the coordinator can re-check task distribution.
  // Note: this is a summary notification to the leader, not a per-task unblock event.
  // We set taskId to completedTaskId (the blocker that just completed) and
  // unblockedBy to completedTaskId so the leader knows which blocker changed state.
  // The leader can then call findUnblockedTasks() to discover newly available tasks.
  const leaderNotif: TaskNotification = {
    type: "task_unblocked",
    taskId: completedTaskId,
    unblockedBy: completedTaskId,
  };
  await writeToMailbox(cwd, "team-lead", {
    from: "task-system",
    text: JSON.stringify(leaderNotif),
    timestamp: new Date().toISOString(),
  }, teamName);
}

/**
 * Verification nudge — when 3+ tasks are completed without a
 * verification step, suggest spawning a reviewer agent.
 */
export async function nudgeVerification(
  cwd: string,
  teamName: string,
  allTasks: TaskItem[],
): Promise<void> {
  const tasks = allTasks;
  const completed = tasks.filter(t => t.status === "completed");
  if (completed.length < 3) return;
  const hasVerification = tasks.some(t =>
    /verif|test|check|review|valid/i.test(t.subject),
  );
  if (hasVerification) return;

  // Check team-level nudge state first (survives task deletion)
  const nudgeState = readNudgeState(cwd, teamName);
  if (nudgeState.verificationNudgeSent) return;

  // Legacy check: also check per-task metadata in case the team file
  // was deleted but tasks still have the mark.
  const alreadyNudged = completed.some(t =>
    t.metadata?.verificationNudgeSent === true,
  );
  if (alreadyNudged) return;

  const notif: TaskNotification = {
    type: "verification_nudge",
    message: `${completed.length} tasks completed without verification. Consider spawning a reviewer.`,
  };
  await writeToMailbox(cwd, "team-lead", {
    from: "task-system",
    text: JSON.stringify(notif),
    timestamp: new Date().toISOString(),
  }, teamName);

  // Mark nudge as sent in team-level state file (persists across task deletion)
  writeNudgeState(cwd, teamName, {
    verificationNudgeSent: true,
    verificationNudgeSentAt: Date.now(),
  });

  // Also mark on the first completed task's metadata for backward compat.
  // Uses the registered callback to avoid importing shared-tasks.ts (circular dep).
  if (_markNudgeSentFn) {
    const target = completed.find(t => !t.metadata?.verificationNudgeSent);
    if (target) {
      try {
        await _markNudgeSentFn(cwd, teamName, target.id);
      } catch (err) {
        console.warn(`[aim] Failed to mark verification nudge on task #${target.id}:`, err);
      }
    }
  }
}

/**
 * Send a task completed notification to the team leader.
 * Called when a task transitions to "completed" status.
 */
export async function notifyTaskCompleted(
  cwd: string,
  teamName: string,
  taskId: string,
  completedBy: string,
): Promise<void> {
  const notif: TaskNotification = {
    type: "task_completed",
    taskId,
    completedBy,
  };
  await writeToMailbox(cwd, "team-lead", {
    from: "task-system",
    text: JSON.stringify(notif),
    timestamp: new Date().toISOString(),
  }, teamName);
}

/**
 * Send a task assignment notification to an agent's mailbox.
 * Called when a task is assigned to an agent (either manually or automatically).
 */
export async function notifyTaskAssignment(
  cwd: string,
  agentName: string,
  teamName: string,
  taskId: string,
  subject: string,
  assignedBy: string,
): Promise<void> {
  const notif: TaskNotification = {
    type: "task_assigned",
    taskId,
    subject,
    assignedBy,
  };
  await writeToMailbox(cwd, agentName, {
    from: "task-system",
    text: JSON.stringify(notif),
    timestamp: new Date().toISOString(),
  }, teamName);
}