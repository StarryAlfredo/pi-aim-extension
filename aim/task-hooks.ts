/**
 * AIM — Task Hooks System (P1)
 *
 * Lifecycle hooks for task creation and completion.
 * Hooks can validate or veto operations by returning { allowed: false, reason }.
 *
 * Design mirrors Claude Code's executeTaskCreatedHooks / executeTaskCompletedHooks:
 *   - Created hooks run after the task file is written but before returning to caller.
 *     If a hook vetos, the task file is deleted and createTask throws.
 *   - Completed hooks run before the status transition is committed.
 *     If a hook vetos, the transition is rejected and updateTask throws.
 *
 * Hook execution order: first-registered runs first.
 * All hooks must approve for the operation to proceed.
 */

import type { TaskItem, TaskStatus } from "./types.js";

// ============================================================================
// Types
// ============================================================================

/** Context provided to hook functions */
export interface HookContext {
  /** Working directory */
  cwd: string;
  /** Team name */
  team: string;
  /** Name of the agent performing the operation (if known) */
  agentName?: string;
}

/** Result of a hook: allow or veto with reason */
export type HookResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/** Hook signature for task creation */
export type TaskCreatedHook = (task: TaskItem, ctx: HookContext) => Promise<HookResult>;

/** Hook signature for task completion / terminal transition */
export type TaskCompletedHook = (task: TaskItem, newStatus: TaskStatus, ctx: HookContext) => Promise<HookResult>;

/** Hook signature for task status transition (runs for ALL transitions, not just terminal) */
export type TaskTransitionHook = (task: TaskItem, fromStatus: TaskStatus, toStatus: TaskStatus, ctx: HookContext) => Promise<HookResult>;

// ============================================================================
// Registry
// ============================================================================

const createdHooks: TaskCreatedHook[] = [];
const completedHooks: TaskCompletedHook[] = [];
const transitionHooks: TaskTransitionHook[] = [];

// ============================================================================
// Registration
// ============================================================================

/**
 * Register a hook that runs when a new task is created.
 * Called after the task file is written but before returning to the caller.
 * If any hook returns { allowed: false }, the task is deleted and createTask throws.
 */
export function registerTaskCreatedHook(hook: TaskCreatedHook): void {
  createdHooks.push(hook);
}

/**
 * Register a hook that runs when a task transitions to a terminal state
 * (completed, failed, or killed).
 * If any hook returns { allowed: false }, the transition is rejected.
 */
export function registerTaskCompletedHook(hook: TaskCompletedHook): void {
  completedHooks.push(hook);
}

/**
 * Register a hook that runs on ANY status transition.
 * Runs after transition-specific validation (canTransition) but before the
 * transition is committed. If any hook returns { allowed: false }, the
 * transition is rejected.
 *
 * This is more general than TaskCompletedHook — use it for cross-cutting
 * concerns like logging, auditing, or custom transition rules.
 */
export function registerTaskTransitionHook(hook: TaskTransitionHook): void {
  transitionHooks.push(hook);
}

// ============================================================================
// Execution
// ============================================================================

/**
 * Execute all registered created hooks.
 * Returns the first veto result, or { allowed: true } if all approve.
 */
export async function executeTaskCreatedHooks(
  task: TaskItem,
  ctx: HookContext,
): Promise<HookResult> {
  for (const hook of createdHooks) {
    try {
      const result = await hook(task, ctx);
      if (!result.allowed) return result;
    } catch (err) {
      // Hook threw → treat as veto with error message
      return { allowed: false, reason: `Hook error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { allowed: true };
}

/**
 * Execute all registered completed hooks for a terminal transition.
 * Returns the first veto result, or { allowed: true } if all approve.
 */
export async function executeTaskCompletedHooks(
  task: TaskItem,
  newStatus: TaskStatus,
  ctx: HookContext,
): Promise<HookResult> {
  for (const hook of completedHooks) {
    try {
      const result = await hook(task, newStatus, ctx);
      if (!result.allowed) return result;
    } catch (err) {
      return { allowed: false, reason: `Hook error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { allowed: true };
}

/**
 * Execute all registered transition hooks.
 * Returns the first veto result, or { allowed: true } if all approve.
 */
export async function executeTaskTransitionHooks(
  task: TaskItem,
  fromStatus: TaskStatus,
  toStatus: TaskStatus,
  ctx: HookContext,
): Promise<HookResult> {
  for (const hook of transitionHooks) {
    try {
      const result = await hook(task, fromStatus, toStatus, ctx);
      if (!result.allowed) return result;
    } catch (err) {
      return { allowed: false, reason: `Hook error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { allowed: true };
}

// ============================================================================
// Utility: clear all hooks (for testing)
// ============================================================================

export function clearAllHooks(): void {
  createdHooks.length = 0;
  completedHooks.length = 0;
  transitionHooks.length = 0;
}