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
import type { WorkerInfo } from "./types.js";

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

  while (!signal.aborted) {
    // Wait for worker to become idle (completed current task)
    const info = workerPool.getInfo(workerId);
    if (!info || info.state === "dead") return;

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
        // Inject the task as a new prompt
        const injected = workerPool.followUp(workerId, result.prompt);
        if (!injected) return;
        break;
      }

      case "aborted":
        return;

      // Nothing found — sleep and retry
      default: {
        config.onIdle?.();
        // Send idle notification once per idle cycle
        await sendIdleNotification(cwd, agentName, teamName, {
          idleReason: "available",
        });
        await new Promise(r => setTimeout(r, POLL_GAP_MS));
        break;
      }
    }
  }
}