/**
 * AIM — Agent Lifecycle
 *
 * Unified lifecycle management for subagent execution.
 * Encapsulates the creation and cleanup of progress trackers, display states,
 * and worktrees — replacing scattered create/cleanup calls with a single
 * interface.
 *
 * Before this module, agent-executor.ts had to:
 *   - createProgressTracker + recordStatusChange + createDisplayState (start)
 *   - markCompleted + setTimeout(removeProgressTracker + removeDisplayState) (end)
 *   - removeWorktreeByBase (end)
 *
 * And this was duplicated across resume, foreground, and background paths.
 * Now callers use: agentStarted() → agentCompleted()/agentFailed().
 */

import {
  createProgressTracker,
  recordStatusChange,
  recordError,
  removeProgressTracker,
  persistProgress,
} from "./task-progress.js";
import {
  createDisplayState,
  markCompleted,
  removeDisplayState,
} from "./task-foreground.js";
import { removeWorktreeByBase } from "./worktree.js";

// ============================================================================
// Constants
// ============================================================================

/** Delay before cleaning up progress/display state after completion (ms) */
const CLEANUP_DELAY_MS = 5000;

/** Default auto-background timeout for display state (ms) */
const DEFAULT_AUTO_BACKGROUND_MS = 60_000;

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize all tracking state for a newly started agent.
 *
 * Creates:
 *   - Progress tracker (always — captures tool/token events from attachStdout)
 *   - Display state (only if foreground — background agents don't need it)
 *
 * IMPORTANT: Must be called BEFORE workerPool.spawn() so that events
 * from attachStdout are never lost.
 *
 * @param agentId Unique agent ID
 * @param options Lifecycle options
 */
export function agentStarted(
  agentId: string,
  options: {
    /** Whether this is a foreground agent (creates display state) */
    foreground: boolean;
    /** Auto-background timeout in ms (default: 60s, 0 = disabled) */
    autoBackgroundAfterMs?: number;
    /** Initial status to record (default: "worker_spawned") */
    initialStatus?: string;
  },
): void {
  // Progress tracker: always created — captures events from worker stdout
  createProgressTracker(agentId);
  recordStatusChange(agentId, options.initialStatus ?? "worker_spawned");

  // Display state: only for foreground agents
  if (options.foreground) {
    createDisplayState(agentId, {
      isForeground: true,
      autoBackgroundAfterMs: options.autoBackgroundAfterMs ?? DEFAULT_AUTO_BACKGROUND_MS,
      retain: false,
    });
  }
}

/**
 * Clean up all tracking state after an agent completes successfully.
 *
 * Handles:
 *   - Marking display state as completed
 *   - Scheduling progress/display cleanup after a delay
 *   - Removing worktree (if provided)
 *
 * @param agentId Agent ID
 * @param cwd Working directory
 * @param worktreeBaseDir Worktree base directory to remove (null if no worktree)
 */
export function agentCompleted(
  agentId: string,
  cwd: string,
  worktreeBaseDir: string | null,
): void {
  markCompleted(agentId);
  scheduleCleanup(agentId, cwd);
  removeWorktree(cwd, worktreeBaseDir);
}

/**
 * Clean up all tracking state after an agent fails.
 *
 * Same as agentCompleted but also records the error in the progress tracker.
 *
 * @param agentId Agent ID
 * @param cwd Working directory
 * @param error Error description
 * @param worktreeBaseDir Worktree base directory to remove (null if no worktree)
 */
export function agentFailed(
  agentId: string,
  cwd: string,
  error: string,
  worktreeBaseDir: string | null,
): void {
  recordError(agentId, error);
  markCompleted(agentId, { failed: true });
  scheduleCleanup(agentId, cwd);
  removeWorktree(cwd, worktreeBaseDir);
}

/**
 * Prepare lifecycle state for a resume operation.
 *
 * Creates progress tracker (always) and display state (if foreground).
 * Used by the resume path in agent-executor.ts.
 */
export function agentResumed(
  agentId: string,
  options: {
    foreground: boolean;
    autoBackgroundAfterMs?: number;
  },
): void {
  createProgressTracker(agentId);
  recordStatusChange(agentId, "resumed");

  if (options.foreground) {
    createDisplayState(agentId, {
      isForeground: true,
      autoBackgroundAfterMs: options.autoBackgroundAfterMs ?? DEFAULT_AUTO_BACKGROUND_MS,
      retain: false,
    });
  }
}

/**
 * Prepare lifecycle state for a background agent launch.
 *
 * Creates progress tracker only (no display state — background agents
 * don't show in UI and would leak without markCompleted).
 */
export function agentBackgroundLaunched(agentId: string): void {
  createProgressTracker(agentId);
  recordStatusChange(agentId, "background_launched");
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Schedule delayed cleanup of progress tracker and display state.
 *
 * The delay allows final rendering to complete before state is removed.
 * Progress is persisted to disk before cleanup for crash recovery.
 */
function scheduleCleanup(agentId: string, cwd: string): void {
  setTimeout(() => {
    persistProgress(cwd, agentId);
    removeProgressTracker(agentId);
    removeDisplayState(agentId);
  }, CLEANUP_DELAY_MS);
}

/**
 * Remove a worktree by its base directory.
 * Safe to call with null (no-op).
 */
function removeWorktree(cwd: string, worktreeBaseDir: string | null): void {
  if (worktreeBaseDir) {
    removeWorktreeByBase(cwd, worktreeBaseDir);
  }
}
