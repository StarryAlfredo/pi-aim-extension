/**
 * AIM — Teammate Loop
 *
 * Manages the autonomous poll→process→idle cycle for teammates.
 * When a teammate RPC worker reaches idle state (agent_end with no
 * pending follow_up), the loop polls the inbox and task list for
 * new work, injecting it via followUp.
 *
 * Follows Claude Code's inProcessRunner pattern: the team leader
 * owns the poll loop, feeding work to teammate workers as it arrives.
 */

import { pollInbox, sendIdleNotification, type PollResult } from "./poller.js";
import { workerPool } from "./worker-pool.js";
import { updateTask, forceTaskStatus } from "./shared-tasks.js";
import type { WorkerInfo } from "./types.js";
// P3: Progress tracking for idle notifications
import { getProgressTracker, generateCompactSummary, persistProgress } from "./task-progress.js";

// ============================================================================
// Types
// ============================================================================

export interface TeammateLoopConfig {
  cwd: string;
  agentName: string;
  teamName: string;
  workerId: string;
  /** Abort signal for stopping the loop */
  signal: AbortSignal;
  /** Optional task ID to auto-complete when the worker finishes work */
  taskId?: string;
  /** Agent ID (UUID) for progress tracking — required since progress trackers are keyed by agentId, not agentName */
  agentId?: string;
  /** Called when the teammate starts processing a new item */
  onActivity?: (item: PollResult) => void;
  /** Called when the teammate enters idle state */
  onIdle?: () => void;
}

// ============================================================================
// Main Loop
// ============================================================================

/**
 * Run the autonomous poll loop for a single teammate.
 * Returns when the signal is aborted or a shutdown is received.
 *
 * The loop:
 *   1. Wait for worker to become idle (agent_end received)
 *   2. Poll inbox + task list for new work
 *   3. If work found → inject via followUp → goto 1
 *   4. If no work → send idle notification → wait → goto 2
 *   5. If shutdown requested → approve and exit
 */
export async function runTeammateLoop(config: TeammateLoopConfig): Promise<void> {
  const { cwd, agentName, teamName, workerId, signal } = config;
  const POLL_GAP_MS = 500;

  // Track the currently active task ID for auto-completion.
  // Set when a task is claimed via poller, cleared when auto-completed.
  // This bridges the gap where teams.ts doesn't pass taskId in the config —
  // the loop discovers the task through the poller instead.
  let activeTaskId: string | undefined = config.taskId;

  while (!signal.aborted) {
    // Wait for worker to become idle (completed current task)
    const info = workerPool.getInfo(workerId);
    if (!info || info.state === "dead") {
      // Worker is dead on entry — clean up the associated task if any.
      // Without this, the task stays in_progress forever since no one
      // will complete it.
      if (activeTaskId) {
        try {
          await forceTaskStatus(cwd, teamName, activeTaskId, "failed", "worker_died_on_entry");
        } catch (err: any) {
          console.error(`[aim] CRITICAL: Failed to force-fail task #${activeTaskId} on worker death: ${err.message}. Task may be stuck in_progress.`);
        }
      }
      return;
    }

    // Track whether the worker just transitioned from running → idle (normal completion)
    let justCompletedWork = false;

    // If worker is running, wait for it to finish
    if (info.state === "running") {
      // Wait for next agent_end (poll-based, 200ms interval)
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          const current = workerPool.getInfo(workerId);
          if (!current || current.state === "dead" || current.state === "idle") {
            clearInterval(check);
            resolve();
          }
          if (signal.aborted) { clearInterval(check); resolve(); }
        }, 200);
      });
      if (signal.aborted) return;

      // Check the final state — distinguish normal completion from crash
      const finalInfo = workerPool.getInfo(workerId);
      const completedNormally = finalInfo?.state === "idle";
      justCompletedWork = completedNormally;

      // Auto-complete or fail the associated task now that the worker has finished.
      if (activeTaskId) {
        if (completedNormally) {
          // Normal completion — try to mark task as completed
          try {
            await updateTask(cwd, teamName, activeTaskId, { status: "completed" });
          } catch (completedErr: any) {
            // Completion hook vetoed (e.g. verification not done) — force to failed.
            console.warn(`[aim] Hook vetoed completion of task #${activeTaskId}: ${completedErr.message}. Forcing failed status.`);
            try {
              await forceTaskStatus(cwd, teamName, activeTaskId, "failed", `completion_hook_veto: ${completedErr.message}`);
            } catch (forceErr: any) {
              console.error(`[aim] CRITICAL: Failed to force-fail task #${activeTaskId}: ${forceErr.message}. Task may be stuck in_progress.`);
            }
          }
        } else {
          // Worker crashed or died — force the task to failed
          console.warn(`[aim] Worker died while processing task #${activeTaskId}. Forcing failed status.`);
          try {
            await forceTaskStatus(cwd, teamName, activeTaskId, "failed", "worker_died");
          } catch (forceErr: any) {
            console.error(`[aim] CRITICAL: Failed to force-fail task #${activeTaskId}: ${forceErr.message}. Task may be stuck in_progress.`);
          }
        }
        // Clear the active task after completion attempt (success or forced failure)
        activeTaskId = undefined;
      }
    }

    // Worker is now idle. Check if there's work to do.
    const result = await pollInbox(cwd, agentName, teamName, signal);
    if (signal.aborted) return;

    switch (result.type) {
      case "shutdown_request":
        // Accept shutdown and exit loop
        config.onActivity?.(result);
        return;

      case "new_message": {
        config.onActivity?.(result);
        // Inject the message as a new prompt
        const injected = workerPool.followUp(workerId, result.message);
        if (!injected) {
          // Worker dead — can't continue
          return;
        }
        break;
      }

      case "task_claimed": {
        config.onActivity?.(result);
        // Track the claimed task for auto-completion when the worker finishes.
        // This ensures tasks are marked completed even when taskId wasn't
        // passed in the initial config (e.g. via spawnTeammate in teams.ts).
        activeTaskId = result.taskId;
        // Inject the task as a new prompt
        const injected = workerPool.followUp(workerId, result.prompt);
        if (!injected) return;
        break;
      }

      case "task_notification": {
        // Task system notification (assignment, unblocked, verification nudge).
        // Log the notification but don't inject anything into the worker —
        // the poller already attempted to claim a task if appropriate.
        config.onActivity?.(result);
        // If this was a task_assigned that the poller couldn't claim (e.g. agent busy),
        // just acknowledge and continue polling.
        break;
      }

      case "task_unblocked": {
        // A dependency task completed — new tasks may be available.
        config.onActivity?.(result);
        // Re-poll immediately: the unblocked task may be claimable
        break;
      }

      case "aborted":
        return;

      // Nothing found — sleep and retry
      default: {
        config.onIdle?.();
        // Send idle notification once per idle cycle.
        // If the worker just completed work, indicate that in the notification.
        await sendIdleNotification(cwd, agentName, teamName, {
          idleReason: justCompletedWork ? "completed" : "available",
          // P3: Include progress summary in idle notification
          summary: getProgressTracker(config.agentId ?? agentName)
            ? generateCompactSummary(config.agentId ?? agentName)
            : undefined,
        });
        // P3: Persist progress on each idle cycle (periodic checkpoint)
        persistProgress(cwd, config.agentId ?? agentName);
        await new Promise(r => setTimeout(r, POLL_GAP_MS));
        break;
      }
    }
  }
}