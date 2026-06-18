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

import { progressTracker } from "./task-progress.js";

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
  /** Whether the task ended in a failed/killed state (for extended evict delay) */
  _isFailed?: boolean;
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
// DisplayManager Class
// ============================================================================

/**
 * Manages the foreground/background display state of running tasks.
 * Encapsulates the display states registry, callbacks, and timer management.
 */
export class DisplayManager {
  private displayStates = new Map<string, TaskDisplayState>();
  private transitionCallbacks: Array<(id: string, isForeground: boolean) => void> = [];
  private evictCallbacks: Array<(id: string) => void> = [];

  /**
   * Register a callback for foreground/background transitions.
   * Called after the transition is applied.
   */
  onTransition(cb: (id: string, isForeground: boolean) => void): void {
    this.transitionCallbacks.push(cb);
  }

  /**
   * Register a callback for task display eviction.
   * Called when a completed task's display is removed.
   */
  onEvict(cb: (id: string) => void): void {
    this.evictCallbacks.push(cb);
  }

  /**
   * Create a display state for a new task.
   * @param id Task/agent ID
   * @param options Display options
   */
  create(id: string, options?: {
    isForeground?: boolean;
    autoBackgroundAfterMs?: number;
    retain?: boolean;
    evictAfterMs?: number;
  }): TaskDisplayState {
    const state: TaskDisplayState = {
      id,
      isForeground: options?.isForeground ?? true,
      autoBackgroundAfterMs: options?.autoBackgroundAfterMs ?? DEFAULT_AUTO_BACKGROUND_MS,
      retain: options?.retain ?? false,
      evictAfterMs: options?.evictAfterMs ?? (options?.retain ? DEFAULT_EVICT_AFTER_MS : undefined),
    };

    this.displayStates.set(id, state);

    // Start auto-background timer if configured
    if (state.isForeground && state.autoBackgroundAfterMs > 0) {
      this.startAutoBackgroundTimer(state);
    }

    return state;
  }

  /**
   * Get the display state for a task.
   */
  get(id: string): TaskDisplayState | null {
    return this.displayStates.get(id) ?? null;
  }

  /**
   * Check if a task is currently in the foreground.
   */
  isForeground(id: string): boolean {
    return this.displayStates.get(id)?.isForeground ?? false;
  }

  /**
   * Get all foreground task IDs.
   */
  getForegroundTasks(): string[] {
    return Array.from(this.displayStates.values())
      .filter(s => s.isForeground)
      .map(s => s.id);
  }

  /**
   * Get all background task IDs.
   */
  getBackgroundTasks(): string[] {
    return Array.from(this.displayStates.values())
      .filter(s => !s.isForeground)
      .map(s => s.id);
  }

  /**
   * Check if there are any foreground tasks.
   */
  hasForegroundTasks(): boolean {
    for (const s of this.displayStates.values()) {
      if (s.isForeground) return true;
    }
    return false;
  }

  /**
   * Move a task to the background.
   * Stops the auto-background timer and notifies callbacks.
   */
  background(id: string): TransitionResult {
    const state = this.displayStates.get(id);
    if (!state) {
      return {
        success: false,
        reason: "not_found",
        state: this.createPlaceholderState(id),
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
    for (const cb of this.transitionCallbacks) {
      try { cb(id, false); } catch (err) { console.warn(`[aim] Transition callback error for ${id}:`, err); }
    }

    return { success: true, state };
  }

  /**
   * Bring a background task back to the foreground.
   * Restarts the auto-background timer.
   */
  foreground(id: string): TransitionResult {
    const state = this.displayStates.get(id);
    if (!state) {
      return {
        success: false,
        reason: "not_found",
        state: this.createPlaceholderState(id),
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
      this.startAutoBackgroundTimer(state);
    }

    // Notify callbacks
    for (const cb of this.transitionCallbacks) {
      try { cb(id, true); } catch (err) { console.warn(`[aim] Transition callback error for ${id}:`, err); }
    }

    return { success: true, state };
  }

  /**
   * Move ALL foreground tasks to the background.
   * Used when the user wants to reclaim the terminal.
   *
   * @returns Number of tasks backgrounded
   */
  backgroundAll(): number {
    let count = 0;
    // Collect IDs first to avoid iterating a Map while modifying it.
    // backgroundTask() only modifies fields (not deletes), but defensive
    // programming protects against future changes.
    const ids = Array.from(this.displayStates.keys());
    for (const id of ids) {
      const state = this.displayStates.get(id);
      if (state?.isForeground) {
        const result = this.background(id);
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
  markCompleted(id: string, options?: { failed?: boolean }): void {
    const state = this.displayStates.get(id);
    if (!state) return;

    state.completedAt = Date.now();
    state._isFailed = options?.failed ?? false;

    // Clear auto-background timer (no longer needed)
    if (state._autoBgTimer !== undefined) {
      clearTimeout(state._autoBgTimer);
      state._autoBgTimer = undefined;
    }

    if (state.retain && state.evictAfterMs !== undefined) {
      // Start evict timer. Failed/killed tasks get 2x the evict time
      // to allow debugging — they're more likely to need review than
      // successful completions.
      const effectiveEvictMs = state._isFailed
        ? state.evictAfterMs * 2
        : state.evictAfterMs;
      if (state._evictTimer !== undefined) clearTimeout(state._evictTimer);
      state._evictTimer = setTimeout(() => {
        this.evict(id);
      }, effectiveEvictMs);
    } else if (!state.retain) {
      // No retain — remove display state after a brief delay.
      // Failed tasks get a longer delay (10s vs 2s) for review.
      const removeDelay = state._isFailed ? 10_000 : 2_000;
      setTimeout(() => {
        this.remove(id);
      }, removeDelay).unref();
    }
  }

  /**
   * Evict a completed task's display.
   * Called by the evict timer or manually.
   */
  evict(id: string): void {
    const state = this.displayStates.get(id);
    if (!state) return;

    if (state._evictTimer !== undefined) {
      clearTimeout(state._evictTimer);
      state._evictTimer = undefined;
    }

    // Notify eviction callbacks before removing
    for (const cb of this.evictCallbacks) {
      try { cb(id); } catch (err) { console.warn(`[aim] Evict callback error for ${id}:`, err); }
    }

    this.displayStates.delete(id);
  }

  /**
   * Reset the auto-background timer for a task.
   * Called when the user interacts with a foreground task
   * (e.g. sends a follow-up message, approves a permission).
   */
  resetAutoBackgroundTimer(id: string): void {
    const state = this.displayStates.get(id);
    if (!state || !state.isForeground) return;

    if (state._autoBgTimer !== undefined) {
      clearTimeout(state._autoBgTimer);
    }

    if (state.autoBackgroundAfterMs > 0) {
      this.startAutoBackgroundTimer(state);
    }
  }

  /**
   * Remove a display state (cleanup after task is fully done).
   */
  remove(id: string): void {
    const state = this.displayStates.get(id);
    if (!state) return;

    if (state._autoBgTimer !== undefined) {
      clearTimeout(state._autoBgTimer);
    }
    if (state._evictTimer !== undefined) {
      clearTimeout(state._evictTimer);
    }

    this.displayStates.delete(id);
  }

  /**
   * Clean up all display states.
   * Called during session cleanup.
   */
  clearAll(): void {
    for (const [, state] of this.displayStates) {
      if (state._autoBgTimer !== undefined) clearTimeout(state._autoBgTimer);
      if (state._evictTimer !== undefined) clearTimeout(state._evictTimer);
    }
    this.displayStates.clear();
  }

  /**
   * Clean up completed display states older than maxAgeMs.
   * Returns the number of states removed.
   */
  cleanupCompleted(maxAgeMs = 3_600_000): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, state] of this.displayStates) {
      if (state.completedAt && now - state.completedAt > maxAgeMs) {
        this.remove(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Format a display state summary for TUI rendering.
   */
  formatSummary(id: string): string {
    const state = this.displayStates.get(id);
    if (!state) return "(no display state)";

    const parts: string[] = [];
    parts.push(state.isForeground ? "🖥️ foreground" : "⏸️ background");

    if (state.backgroundedAt) {
      const bgSec = Math.round((Date.now() - state.backgroundedAt) / 1000);
      parts.push(`(${bgSec}s ago)`);
    }

    const progress = progressTracker.get(id);
    if (progress) {
      parts.push(`— ${progressTracker.generateCompactSummary(id)}`);
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
  formatBackgroundTaskList(): string[] {
    const bgTasks = Array.from(this.displayStates.values()).filter(s => !s.isForeground);
    if (bgTasks.length === 0) return ["(no background tasks)"];

    return bgTasks.map(state => {
      const progress = progressTracker.get(state.id);
      const status = state.completedAt ? "✓ done" : progress ? progressTracker.generateCompactSummary(state.id) : "running";
      const elapsed = state.backgroundedAt
        ? `${Math.round((Date.now() - state.backgroundedAt) / 1000)}s`
        : "?";
      return `${state.id} (${elapsed} in bg) — ${status}`;
    });
  }

  private createPlaceholderState(id: string): TaskDisplayState {
    return {
      id,
      isForeground: false,
      autoBackgroundAfterMs: 0,
      retain: false,
    };
  }

  private startAutoBackgroundTimer(state: TaskDisplayState): void {
    if (state._autoBgTimer !== undefined) {
      clearTimeout(state._autoBgTimer);
    }
    state._autoBgTimer = setTimeout(() => {
      // Guard: don't auto-background completed tasks
      if (state.completedAt) return;
      if (state.isForeground) {
        this.background(state.id);
      }
    }, state.autoBackgroundAfterMs);
  }
}

// ============================================================================
// Singleton Instance & Backward-Compatible Functional API
// ============================================================================

/** Singleton instance for module-level access */
export const displayManager = new DisplayManager();

/**
 * Register a callback for foreground/background transitions.
 * @deprecated Use displayManager.onTransition() instead
 */
export const onTransition = displayManager.onTransition.bind(displayManager);

/**
 * Register a callback for task display eviction.
 * @deprecated Use displayManager.onEvict() instead
 */
export const onEvict = displayManager.onEvict.bind(displayManager);

/**
 * Create a display state for a new task.
 * @deprecated Use displayManager.create() instead
 */
export const createDisplayState = displayManager.create.bind(displayManager);

/**
 * Get the display state for a task.
 * @deprecated Use displayManager.get() instead
 */
export const getDisplayState = displayManager.get.bind(displayManager);

/**
 * Check if a task is currently in the foreground.
 * @deprecated Use displayManager.isForeground() instead
 */
export const isForeground = displayManager.isForeground.bind(displayManager);

/**
 * Get all foreground task IDs.
 * @deprecated Use displayManager.getForegroundTasks() instead
 */
export const getForegroundTasks = displayManager.getForegroundTasks.bind(displayManager);

/**
 * Get all background task IDs.
 * @deprecated Use displayManager.getBackgroundTasks() instead
 */
export const getBackgroundTasks = displayManager.getBackgroundTasks.bind(displayManager);

/**
 * Check if there are any foreground tasks.
 * @deprecated Use displayManager.hasForegroundTasks() instead
 */
export const hasForegroundTasks = displayManager.hasForegroundTasks.bind(displayManager);

/**
 * Move a task to the background.
 * @deprecated Use displayManager.background() instead
 */
export const backgroundTask = displayManager.background.bind(displayManager);

/**
 * Bring a background task back to the foreground.
 * @deprecated Use displayManager.foreground() instead
 */
export const foregroundTask = displayManager.foreground.bind(displayManager);

/**
 * Move ALL foreground tasks to the background.
 * @deprecated Use displayManager.backgroundAll() instead
 */
export const backgroundAll = displayManager.backgroundAll.bind(displayManager);

/**
 * Mark a task as completed.
 * @deprecated Use displayManager.markCompleted() instead
 */
export const markCompleted = displayManager.markCompleted.bind(displayManager);

/**
 * Evict a completed task's display.
 * @deprecated Use displayManager.evict() instead
 */
export const evictTask = displayManager.evict.bind(displayManager);

/**
 * Reset the auto-background timer for a task.
 * @deprecated Use displayManager.resetAutoBackgroundTimer() instead
 */
export const resetAutoBackgroundTimer = displayManager.resetAutoBackgroundTimer.bind(displayManager);

/**
 * Remove a display state.
 * @deprecated Use displayManager.remove() instead
 */
export const removeDisplayState = displayManager.remove.bind(displayManager);

/**
 * Clean up all display states.
 * @deprecated Use displayManager.clearAll() instead
 */
export const clearAllDisplayStates = displayManager.clearAll.bind(displayManager);

/**
 * Clean up completed display states.
 * @deprecated Use displayManager.cleanupCompleted() instead
 */
export const cleanupCompletedDisplayStates = displayManager.cleanupCompleted.bind(displayManager);

/**
 * Format a display state summary.
 * @deprecated Use displayManager.formatSummary() instead
 */
export const formatDisplayStateSummary = displayManager.formatSummary.bind(displayManager);

/**
 * Format all active tasks for the background tasks dialog.
 * @deprecated Use displayManager.formatBackgroundTaskList() instead
 */
export const formatBackgroundTaskList = displayManager.formatBackgroundTaskList.bind(displayManager);
