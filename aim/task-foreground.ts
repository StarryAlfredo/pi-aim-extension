/**
 * AIM — Task Foreground/Background Management (P4)
 *
 * Manages the foreground/background display state of running tasks.
 * Foreground tasks block the caller and show live output.
 * Background tasks run independently, with progress tracked silently.
 *
 * Design mirrors Claude Code's task foreground/background system:
 *   - Tasks start in foreground by default
 *   - Auto-background after a configurable timeout if no user interaction
 *   - backgroundAll() moves all foreground tasks to background
 *   - foregroundTask() brings a specific task back to the foreground
 *   - Display state (retain/evict) controls post-completion visibility
 *
 * Integration points:
 *   - index.ts: creates TaskDisplayState when spawning agents, uses
 *     auto-background timers during execution
 *   - render.ts: reads display state to decide how to render task output
 *   - teammate-loop.ts: background teammates report status differently
 */

import { getProgressTracker, generateCompactSummary } from "./task-progress.js";

// ============================================================================
// Types
// ============================================================================

/** Display state for a running task */
export interface TaskDisplayState {
  /** The task/agent ID this display state is associated with */
  id: string;
  /** Whether the task is currently in the foreground */
  isForeground: boolean;
  /** Time when the task was moved to background (undefined if foreground) */
  backgroundedAt?: number;
  /** Auto-background timeout in ms. 0 = no auto-background. */
  autoBackgroundAfterMs: number;
  /** Whether to keep the task visible after completion */
  retain: boolean;
  /** If retain=true, how long to keep visible after completion (ms). undefined = forever. */
  evictAfterMs?: number;
  /** Time when the task completed (for evict calculation) */
  completedAt?: number;
  /** The auto-background timer handle */
  _autoBgTimer?: ReturnType<typeof setTimeout>;
  /** The evict timer handle */
  _evictTimer?: ReturnType<typeof setTimeout>;
}

/** Result of a foreground/background transition */
export interface TransitionResult {
  /** Whether the transition succeeded */
  success: boolean;
  /** Reason if failed */
  reason?: string;
  /** The new display state */
  state: TaskDisplayState;
}

// ============================================================================
// Constants
// ============================================================================

/** Default auto-background timeout: 60 seconds */
const DEFAULT_AUTO_BACKGROUND_MS = 60_000;

/** Default evict time after completion: 5 minutes */
const DEFAULT_EVICT_AFTER_MS = 300_000;

// ============================================================================
// In-Memory Registry
// ============================================================================

/** Active display states, keyed by task/agent ID */
const displayStates = new Map<string, TaskDisplayState>();

/** Callbacks invoked when a task transitions between foreground/background */
type TransitionCallback = (id: string, isForeground: boolean) => void;
const transitionCallbacks: TransitionCallback[] = [];

/** Callbacks invoked when a completed task is evicted from display */
type EvictCallback = (id: string) => void;
const evictCallbacks: EvictCallback[] = [];

// ============================================================================
// Callback Registration
// ============================================================================

/**
 * Register a callback for foreground/background transitions.
 * Called after the transition is applied.
 */
export function onTransition(cb: TransitionCallback): void {
  transitionCallbacks.push(cb);
}

/**
 * Register a callback for task display eviction.
 * Called when a completed task's display is removed.
 */
export function onEvict(cb: EvictCallback): void {
  evictCallbacks.push(cb);
}

// ============================================================================
// Creation
// ============================================================================

/**
 * Create a display state for a new task.
 * @param id Task/agent ID
 * @param options Display options
 */
export function createDisplayState(
  id: string,
  options?: {
    isForeground?: boolean;
    autoBackgroundAfterMs?: number;
    retain?: boolean;
    evictAfterMs?: number;
  },
): TaskDisplayState {
  const state: TaskDisplayState = {
    id,
    isForeground: options?.isForeground ?? true,
    autoBackgroundAfterMs: options?.autoBackgroundAfterMs ?? DEFAULT_AUTO_BACKGROUND_MS,
    retain: options?.retain ?? false,
    evictAfterMs: options?.evictAfterMs ?? (options?.retain ? DEFAULT_EVICT_AFTER_MS : undefined),
  };

  displayStates.set(id, state);

  // Start auto-background timer if configured
  if (state.isForeground && state.autoBackgroundAfterMs > 0) {
    startAutoBackgroundTimer(state);
  }

  return state;
}

// ============================================================================
// Queries
// ============================================================================

/**
 * Get the display state for a task.
 */
export function getDisplayState(id: string): TaskDisplayState | null {
  return displayStates.get(id) ?? null;
}

/**
 * Check if a task is currently in the foreground.
 */
export function isForeground(id: string): boolean {
  return displayStates.get(id)?.isForeground ?? false;
}

/**
 * Get all foreground task IDs.
 */
export function getForegroundTasks(): string[] {
  return Array.from(displayStates.values())
    .filter(s => s.isForeground)
    .map(s => s.id);
}

/**
 * Get all background task IDs.
 */
export function getBackgroundTasks(): string[] {
  return Array.from(displayStates.values())
    .filter(s => !s.isForeground)
    .map(s => s.id);
}

/**
 * Check if there are any foreground tasks.
 */
export function hasForegroundTasks(): boolean {
  for (const s of displayStates.values()) {
    if (s.isForeground) return true;
  }
  return false;
}

// ============================================================================
// Transitions
// ============================================================================

/**
 * Move a task to the background.
 * Stops the auto-background timer and notifies callbacks.
 */
export function backgroundTask(id: string): TransitionResult {
  const state = displayStates.get(id);
  if (!state) {
    return {
      success: false,
      reason: "not_found",
      state: createPlaceholderState(id),
    };
  }

  if (!state.isForeground) {
    return {
      success: false,
      reason: "already_background",
      state,
    };
  }

  // Clear auto-background timer
  if (state._autoBgTimer !== undefined) {
    clearTimeout(state._autoBgTimer);
    state._autoBgTimer = undefined;
  }

  state.isForeground = false;
  state.backgroundedAt = Date.now();

  // Notify callbacks
  for (const cb of transitionCallbacks) {
    try { cb(id, false); } catch {}
  }

  return { success: true, state };
}

/**
 * Bring a background task back to the foreground.
 * Restarts the auto-background timer.
 */
export function foregroundTask(id: string): TransitionResult {
  const state = displayStates.get(id);
  if (!state) {
    return {
      success: false,
      reason: "not_found",
      state: createPlaceholderState(id),
    };
  }

  if (state.isForeground) {
    return {
      success: false,
      reason: "already_foreground",
      state,
    };
  }

  state.isForeground = true;
  state.backgroundedAt = undefined;

  // Restart auto-background timer
  if (state.autoBackgroundAfterMs > 0) {
    startAutoBackgroundTimer(state);
  }

  // Notify callbacks
  for (const cb of transitionCallbacks) {
    try { cb(id, true); } catch {}
  }

  return { success: true, state };
}

/**
 * Move ALL foreground tasks to the background.
 * Used when the user wants to reclaim the terminal.
 *
 * @returns Number of tasks backgrounded
 */
export function backgroundAll(): number {
  let count = 0;
  for (const [id, state] of displayStates) {
    if (state.isForeground) {
      const result = backgroundTask(id);
      if (result.success) count++;
    }
  }
  return count;
}

/**
 * Mark a task as completed (for evict timer management).
 * If retain=true, starts the evict timer.
 * If retain=false, the display state is removed after a brief delay.
 */
export function markCompleted(id: string): void {
  const state = displayStates.get(id);
  if (!state) return;

  state.completedAt = Date.now();

  // Clear auto-background timer (no longer needed)
  if (state._autoBgTimer !== undefined) {
    clearTimeout(state._autoBgTimer);
    state._autoBgTimer = undefined;
  }

  if (state.retain && state.evictAfterMs !== undefined) {
    // Start evict timer
    state._evictTimer = setTimeout(() => {
      evictTask(id);
    }, state.evictAfterMs);
  } else if (!state.retain) {
    // No retain — remove display state after a brief delay
    // (gives the renderer one cycle to show the completion)
    setTimeout(() => {
      removeDisplayState(id);
    }, 2000);
  }
}

/**
 * Evict a completed task's display.
 * Called by the evict timer or manually.
 */
export function evictTask(id: string): void {
  const state = displayStates.get(id);
  if (!state) return;

  if (state._evictTimer !== undefined) {
    clearTimeout(state._evictTimer);
    state._evictTimer = undefined;
  }

  // Notify eviction callbacks before removing
  for (const cb of evictCallbacks) {
    try { cb(id); } catch {}
  }

  displayStates.delete(id);
}

/**
 * Reset the auto-background timer for a task.
 * Called when the user interacts with a foreground task
 * (e.g. sends a follow-up message, approves a permission).
 */
export function resetAutoBackgroundTimer(id: string): void {
  const state = displayStates.get(id);
  if (!state || !state.isForeground) return;

  if (state._autoBgTimer !== undefined) {
    clearTimeout(state._autoBgTimer);
  }

  if (state.autoBackgroundAfterMs > 0) {
    startAutoBackgroundTimer(state);
  }
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Remove a display state (cleanup after task is fully done).
 */
export function removeDisplayState(id: string): void {
  const state = displayStates.get(id);
  if (!state) return;

  if (state._autoBgTimer !== undefined) {
    clearTimeout(state._autoBgTimer);
  }
  if (state._evictTimer !== undefined) {
    clearTimeout(state._evictTimer);
  }

  displayStates.delete(id);
}

/**
 * Clean up all display states.
 * Called during session cleanup.
 */
export function clearAllDisplayStates(): void {
  for (const [, state] of displayStates) {
    if (state._autoBgTimer !== undefined) clearTimeout(state._autoBgTimer);
    if (state._evictTimer !== undefined) clearTimeout(state._evictTimer);
  }
  displayStates.clear();
}

/**
 * Clean up completed display states older than maxAgeMs.
 * Returns the number of states removed.
 */
export function cleanupCompletedDisplayStates(maxAgeMs = 3_600_000): number {
  const now = Date.now();
  let removed = 0;
  for (const [id, state] of displayStates) {
    if (state.completedAt && now - state.completedAt > maxAgeMs) {
      removeDisplayState(id);
      removed++;
    }
  }
  return removed;
}

// ============================================================================
// Display Helpers
// ============================================================================

/**
 * Format a display state summary for TUI rendering.
 */
export function formatDisplayStateSummary(id: string): string {
  const state = displayStates.get(id);
  if (!state) return "(no display state)";

  const parts: string[] = [];
  parts.push(state.isForeground ? "🖥️ foreground" : "⏸️ background");

  if (state.backgroundedAt) {
    const bgSec = Math.round((Date.now() - state.backgroundedAt) / 1000);
    parts.push(`(${bgSec}s ago)`);
  }

  const progress = getProgressTracker(id);
  if (progress) {
    parts.push(`— ${generateCompactSummary(id)}`);
  }

  if (state.completedAt) {
    parts.push("✓ completed");
  }

  return parts.join(" ");
}

/**
 * Format all active tasks for the background tasks dialog.
 * Returns a list of formatted lines.
 */
export function formatBackgroundTaskList(): string[] {
  const bgTasks = Array.from(displayStates.values()).filter(s => !s.isForeground);
  if (bgTasks.length === 0) return ["(no background tasks)"];

  return bgTasks.map(state => {
    const progress = getProgressTracker(state.id);
    const status = state.completedAt ? "✓ done" : progress ? generateCompactSummary(state.id) : "running";
    const elapsed = state.backgroundedAt
      ? `${Math.round((Date.now() - state.backgroundedAt) / 1000)}s`
      : "?";
    return `${state.id} (${elapsed} in bg) — ${status}`;
  });
}

// ============================================================================
// Internal Helpers
// ============================================================================

function createPlaceholderState(id: string): TaskDisplayState {
  return {
    id,
    isForeground: false,
    autoBackgroundAfterMs: 0,
    retain: false,
  };
}

function startAutoBackgroundTimer(state: TaskDisplayState): void {
  if (state._autoBgTimer !== undefined) {
    clearTimeout(state._autoBgTimer);
  }
  state._autoBgTimer = setTimeout(() => {
    // Guard: don't auto-background completed tasks
    if (state.completedAt) return;
    if (state.isForeground) {
      backgroundTask(state.id);
    }
  }, state.autoBackgroundAfterMs);
}
