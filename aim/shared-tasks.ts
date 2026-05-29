/**
 * AIM — Shared Task System (P0 rewrite)
 *
 * File-based shared task list for team coordination.
 * Each team gets a task directory at .pi/aim/tasks/{team}/.
 *
 * Task lifecycle:
 *   pending → in_progress → completed / failed / killed
 *
 * P0 changes:
 *   - TaskType: 6 task types for differentiated handling
 *   - State machine: VALID_TRANSITIONS + terminal state protection
 *   - High-water mark: prevents task ID reuse after deletion
 *   - Bidirectional deps: blocks + blockedBy auto-maintained
 *   - Stale lock detection: force-release locks older than 10s
 *   - deleteTask: auto-cleans dependency references
 *
 * Lock strategy (Strategy B — dual-layer):
 *   - Read operations: no lock (eventual consistency)
 *   - All write operations: list lock (.list.lock)
 *   - The list lock serializes all mutations, preventing concurrent
 *     reads of partially-written files during cross-task operations.
 *   - Individual file locks are NOT needed because list lock is exclusive.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  getTasksDir,
  isTerminalStatus,
  canTransition,
  VALID_TRANSITIONS,
  type TaskItem,
  type TaskStatus,
  type TaskType,
} from "./types.ts";

import {
  executeTaskCreatedHooks,
  executeTaskCompletedHooks,
  executeTaskTransitionHooks,
  type HookContext,
} from "./task-hooks.ts";
import { notifyTaskUnblocked, nudgeVerification, notifyTaskAssignment, notifyTaskCompleted, type TaskNotification } from "./task-notifications.ts";
import { writeToMailbox } from "./mailbox.ts";
import { acquireFileLock } from "./lock.ts";

// ============================================================================
// Options & Callbacks
// ============================================================================

/** Options for updating a task */
export interface UpdateTaskOptions {
  /** If true, skip hook execution (infrastructure-level override).
   *  Used by forceTaskStatus and internal fallback paths to ensure
   *  tasks don't get stuck when hooks veto all terminal transitions. */
  skipHooks?: boolean;
}

/** Callback type for checking if an agent is busy.
 *  Registered by the extension entry point (index.ts) to break the circular
 *  dependency: shared-tasks.ts ↔ agent-status.ts */
export type IsAgentBusyFn = (cwd: string, team: string, agentName: string) => boolean;

let _isAgentBusyFn: IsAgentBusyFn | null = null;

/** Register a callback to check if an agent is busy.
 *  Called by claimTask for busy-check, replacing the inline logic.
 *  This breaks the circular dependency: shared-tasks.ts ↔ agent-status.ts. */
export function registerIsAgentBusy(fn: IsAgentBusyFn): void {
  _isAgentBusyFn = fn;
}

/** Callback type for finding a candidate agent for unowned unblocked tasks.
 *  Registered by the extension entry point (index.ts) to break the circular
 *  dependency: shared-tasks.ts ↔ agent-status.ts */
export type FindCandidateAgentFn = (cwd: string, team: string) => string | undefined;

let _findCandidateAgentFn: FindCandidateAgentFn | null = null;

/** Register a callback to find a candidate agent for unowned unblocked tasks.
 *  Called by updateTask when a task completes and its dependents become unblocked.
 *  The callback should return the name of the least-busy idle agent, or undefined. */
export function registerFindCandidateAgent(fn: FindCandidateAgentFn): void {
  _findCandidateAgentFn = fn;
}

// Re-export for convenience
export { isTerminalStatus, canTransition, VALID_TRANSITIONS, type TaskItem, type TaskStatus, type TaskType };

// ============================================================================
// High-water Mark
// ============================================================================

const HIGHWATERMARK_FILE = ".highwatermark";

function readHighwaterMark(dir: string): number {
  const fp = path.join(dir, HIGHWATERMARK_FILE);
  try {
    return Number(fs.readFileSync(fp, "utf-8")) || 0;
  } catch {
    return 0;
  }
}

function writeHighwaterMark(dir: string, mark: number): void {
  fs.writeFileSync(path.join(dir, HIGHWATERMARK_FILE), String(mark));
}

// Lock logic extracted to ./lock.ts — import acquireFileLock from there.

// ============================================================================
// I/O Helpers
// ============================================================================

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
  }
}

function taskFilePath(cwd: string, team: string, taskId: string): string {
  return path.join(getTasksDir(cwd, team), `task-${taskId}.json`);
}

/** Get the list lock path for a team's task directory */
function listLockPath(cwd: string, team: string): string {
  return path.join(getTasksDir(cwd, team), ".list.lock");
}

/** Read a single task file, returns null if not found or invalid */
function readTaskFile(cwd: string, team: string, taskId: string): TaskItem | null {
  const fp = taskFilePath(cwd, team, taskId);
  try {
    const raw = fs.readFileSync(fp, "utf-8");
    try {
      return JSON.parse(raw) as TaskItem;
    } catch (parseErr) {
      // File is corrupted (partial write during crash, etc.)
      console.warn(`[aim] Corrupted task file: ${fp}`, parseErr);
      return null;
    }
  } catch (err: any) {
    if (err.code === "ENOENT") return null; // File doesn't exist — normal
    throw err; // Other I/O errors should bubble up
  }
}

/** Write a single task file (atomic via tmp+rename) */
function writeTaskFile(cwd: string, team: string, task: TaskItem): void {
  const fp = taskFilePath(cwd, team, task.id);
  const tmp = fp + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
  try {
    fs.renameSync(tmp, fp);
  } catch (renameErr: any) {
    // renameSync can fail with EXDEV when tmp and target are on different
    // filesystems (e.g. network drives, symlinks). Fall back to copy+unlink.
    if (renameErr.code === "EXDEV") {
      try {
        fs.copyFileSync(tmp, fp);
        fs.unlinkSync(tmp);
      } catch (copyErr) {
        // Copy fallback also failed — try to clean up tmp and rethrow original
        try { fs.unlinkSync(tmp); } catch {}
        throw renameErr;
      }
    } else {
      throw renameErr;
    }
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Check if adding an edge from blockerId→blockedId would create a cycle
 * in the blocks graph.
 *
 * Walks the blocks graph starting from blockedId (the task that will be
 * blocked). If we can reach blockerId via existing blocks edges, then adding
 * blockerId→blockedId would close the loop, creating a cycle.
 *
 * This catches both direct cycles (A→B→A) and indirect cycles (A→B→C→A).
 *
 * @param allTasks Map of task ID → TaskItem for the team (must be a consistent
 *   snapshot taken inside the list lock)
 * @param startId The task that will be blocked (we walk from here)
 * @param targetId The blocker — if reachable from startId via blocks, it's a cycle
 */
function wouldCreateCycle(
  allTasks: Map<string, TaskItem>,
  startId: string,
  targetId: string,
): boolean {
  const visited = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === targetId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const task = allTasks.get(current);
    if (task) {
      for (const blockedId of task.blocks) {
        queue.push(blockedId);
      }
    }
  }
  return false;
}

// ============================================================================
// Public API — Queries (no lock needed — eventual consistency)
// ============================================================================

/** Read all tasks for a team, sorted by ID (numeric ascending).
 *
 *  No lock — read-only query (eventual consistency).
 *  This is safe because:
 *    - Within a lock holder (claimTask, createTask, etc.), listTasks
 *      sees a consistent view since the list lock prevents concurrent writes.
 *    - From outside a lock, reads may be slightly stale but never corrupt
 *      (JSON file writes are atomic on both POSIX and NTFS).
 *  For cross-task atomic queries, use the lock-protected functions
 *  (claimTask, createTask, etc.) which call listTasks inside their lock.
 */
export function listTasks(cwd: string, team: string): TaskItem[] {
  const dir = getTasksDir(cwd, team);
  if (!fs.existsSync(dir)) return [];
  const tasks: TaskItem[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith("task-") || !f.endsWith(".json")) continue;
      try {
        tasks.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as TaskItem);
      } catch (parseErr) {
        console.warn(`[aim] Corrupted task file skipped: ${path.join(dir, f)}`, parseErr);
      }
    }
  } catch {}
  return tasks.sort((a, b) => Number(a.id) - Number(b.id));
}

/** Read a single task by ID */
export function getTask(cwd: string, team: string, taskId: string): TaskItem | null {
  return readTaskFile(cwd, team, taskId);
}

// ============================================================================
// Public API — Mutations (all use list lock — Strategy B)
// ============================================================================

/** Options for creating a new task */
export interface CreateTaskOptions {
  type?: TaskType;
  activeForm?: string;
  blockedBy?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Create a new task.
 * Uses high-water mark to prevent ID reuse.
 * If blockedBy is specified, auto-maintains the reverse blocks[] on each blocker.
 */
export async function createTask(
  cwd: string,
  team: string,
  subject: string,
  description = "",
  options?: CreateTaskOptions,
): Promise<TaskItem> {
  const dir = getTasksDir(cwd, team);
  ensureDir(dir);
  const release = await acquireFileLock(listLockPath(cwd, team));
  try {
    // High-water mark: always increment, never reuse
    const hwm = readHighwaterMark(dir);
    const nextId = String(hwm + 1);
    writeHighwaterMark(dir, hwm + 1);

    const task: TaskItem = {
      id: nextId,
      type: options?.type ?? "local_agent",
      subject,
      description,
      activeForm: options?.activeForm,
      status: "pending",
      owner: undefined,
      blocks: [],
      blockedBy: options?.blockedBy ?? [],
      metadata: options?.metadata,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Validate blockedBy references BEFORE writing to disk.
    // This prevents orphan task files if a blocker ID is invalid.
    if (task.blockedBy.length > 0) {
      for (const blockerId of task.blockedBy) {
        const blocker = readTaskFile(cwd, team, blockerId);
        if (!blocker) {
          throw new Error(`Cannot create task: blocker #${blockerId} does not exist`);
        }
      }
    }

    writeTaskFile(cwd, team, task);

    // Maintain reverse blocks[] references on blockers.
    // Validation was done above, so all blockers exist at this point.
    if (task.blockedBy.length > 0) {
      for (const blockerId of task.blockedBy) {
        const blocker = readTaskFile(cwd, team, blockerId);
        // Blocker was validated above — if missing here, it was deleted
        // between validation and write. Skip reverse ref silently.
        if (!blocker) continue;
        // Only maintain reverse reference on non-terminal blockers.
        // Terminal blockers have already satisfied the dependency.
        if (!isTerminalStatus(blocker.status) && !blocker.blocks.includes(nextId)) {
          blocker.blocks.push(nextId);
          blocker.updatedAt = Date.now();
          writeTaskFile(cwd, team, blocker);
        }
      }
    }

    // P1: Execute created hooks — if any hook vetos, delete the task and throw
    const hookCtx: HookContext = { cwd, team };
    const hookResult = await executeTaskCreatedHooks(task, hookCtx);
    if (!hookResult.allowed) {
      // Rollback: delete task file, clean up blocker references.
      // Collect rollback errors but don't abort the rollback — best-effort cleanup.
      const rollbackErrors: string[] = [];
      try { fs.unlinkSync(taskFilePath(cwd, team, nextId)); } catch (e: any) {
        rollbackErrors.push(`Failed to delete task file: ${e.message}`);
      }
      for (const blockerId of task.blockedBy) {
        try {
          const blocker = readTaskFile(cwd, team, blockerId);
          if (blocker) {
            blocker.blocks = blocker.blocks.filter(id => id !== nextId);
            blocker.updatedAt = Date.now();
            writeTaskFile(cwd, team, blocker);
          }
        } catch (e: any) {
          rollbackErrors.push(`Failed to clean blocker #${blockerId}: ${e.message}`);
        }
      }
      if (rollbackErrors.length > 0) {
        console.warn(`[aim] Partial rollback when reverting task #${nextId}: ${rollbackErrors.join("; ")}`);
      }
      throw new Error(`Task creation blocked by hook: ${hookResult.reason}`);
    }

    return task;
  } finally {
    await release();
  }
}

/**
 * Update a task's status, owner, or other fields.
 * Enforces state machine transitions and terminal state protection.
 * 
 * Strategy B: uses list lock to prevent conflict with cross-task
 * operations (createTask, claimTask, etc.) that may read this task's file.
 */
export async function updateTask(
  cwd: string,
  team: string,
  taskId: string,
  updates: Partial<Pick<TaskItem, "status" | "owner" | "description" | "activeForm" | "metadata">>,
  options?: UpdateTaskOptions,
): Promise<TaskItem | null> {
  // Post-lock actions: collected during the locked section, executed after
  // the lock is released. This prevents deadlocks when notifications or
  // failure propagation need to acquire the same list lock.
  const postLockActions: (() => Promise<void>)[] = [];
  let result: TaskItem | null = null;

  const release = await acquireFileLock(listLockPath(cwd, team));
  try {
    // TOCTOU-safe: check existence inside the lock
    const fp = taskFilePath(cwd, team, taskId);
    if (!fs.existsSync(fp)) return null;

    const task = JSON.parse(fs.readFileSync(fp, "utf-8")) as TaskItem;

    // Terminal state protection: reject business-field mutations on completed/failed/killed tasks.
    // metadata updates are allowed on terminal tasks (e.g. recording completion metrics).
    if (isTerminalStatus(task.status)) {
      const hasBusinessChange = updates.status !== undefined ||
        updates.owner !== undefined ||
        updates.description !== undefined ||
        updates.activeForm !== undefined;
      if (hasBusinessChange) {
        throw new Error(`Cannot update task #${taskId}: status is "${task.status}" (terminal). Only metadata updates are allowed.`);
      }
      // Allow metadata-only updates on terminal tasks
      if (updates.metadata !== undefined) {
        task.metadata = updates.metadata;
        task.updatedAt = Date.now();
        writeTaskFile(cwd, team, task);
        return task;
      }
      return null;
    }

    // State transition validation
    if (updates.status !== undefined && updates.status !== task.status) {
      if (!canTransition(task.status, updates.status)) {
        throw new Error(
          `Invalid state transition for task #${taskId}: "${task.status}" → "${updates.status}"` +
          ` (allowed: ${VALID_TRANSITIONS[task.status]?.join(", ") ?? "none"})`,
        );
      }

      // P1: Execute hooks unless skipHooks is set (infrastructure-level override).
      // skipHooks is used by forceTaskStatus and internal fallback paths to ensure
      // tasks don't get stuck when hooks veto all terminal transitions.
      if (!options?.skipHooks) {
        const hookCtx: HookContext = { cwd, team };

        // P1: Execute completed hooks FIRST for terminal transitions.
        // Completed hooks are more specific business rules ("is this task actually
        // done?") and should veto before the broader transition hooks run.
        if (isTerminalStatus(updates.status)) {
          const completedResult = await executeTaskCompletedHooks(task, updates.status, hookCtx);
          if (!completedResult.allowed) {
            throw new Error(
              `Task #${taskId} completion blocked by hook: ${completedResult.reason}`,
            );
          }
        }

        // P1: Then execute transition hooks for any status change (broader rule).
        const transitionResult = await executeTaskTransitionHooks(task, task.status, updates.status, hookCtx);
        if (!transitionResult.allowed) {
          throw new Error(
            `Status transition for task #${taskId} blocked by hook: ${transitionResult.reason}`,
          );
        }
      }
    }

    // Capture the previous owner before applying updates (for assignment notification)
    const previousOwner = task.owner;

    // Apply updates
    if (updates.status !== undefined) task.status = updates.status;
    if (updates.owner !== undefined) task.owner = updates.owner;
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.activeForm !== undefined) task.activeForm = updates.activeForm;
    if (updates.metadata !== undefined) task.metadata = updates.metadata;



    task.updatedAt = Date.now();

    writeTaskFile(cwd, team, task);
    result = task;

    // Collect post-lock side effects (notifications, propagation).
    // These must run outside the lock to avoid deadlock — they may need
    // to acquire the same list lock (e.g. propagateFailureToBlocked → lock).
    if (updates.owner !== undefined && updates.owner !== previousOwner && !isTerminalStatus(task.status)) {
      const owner = updates.owner;
      postLockActions.push(() => notifyTaskAssignment(cwd, owner, team, taskId, task.subject, "team-lead"));
    }

    if (isTerminalStatus(task.status)) {
      // Capture task snapshot inside lock for consistent view.
      // Pass to notification functions to break the circular dependency
      // (task-notifications.ts no longer calls listTasks from shared-tasks.ts).
      const taskSnapshot = listTasks(cwd, team);

      if (task.status === "completed") {
        // Find candidate agent for unowned unblocked tasks (breaks circular dep on agent-status.ts)
        const candidateAgent = _findCandidateAgentFn?.(cwd, team);
        postLockActions.push(() => notifyTaskUnblocked(cwd, team, taskId, taskSnapshot, candidateAgent));
        postLockActions.push(() => nudgeVerification(cwd, team, taskSnapshot));
        // Notify team leader that this task completed (for coordinator awareness)
        postLockActions.push(() => notifyTaskCompleted(cwd, team, taskId, task.owner ?? "unknown"));
      } else {
        postLockActions.push(() => propagateFailureToBlocked(cwd, team, taskId));
      }
    }
  } finally {
    await release();
  }

  // Execute post-lock actions outside the critical section.
  // Errors here are non-fatal — the task update itself has already succeeded.
  for (const action of postLockActions) {
    try {
      await action();
    } catch (err) {
      console.warn(`[aim] Post-lock action failed for task #${taskId}:`, err);
    }
  }

  return result;
}

/**
 * Claim a pending task (sets status to in_progress with owner).
 * Checks: task must be pending, all blockers completed, agent not busy.
 * Returns the claimed task, or a rejection reason.
 * 
 * Strategy B: uses list lock to ensure consistent view of all tasks
 * during blocker and busy checks.
 */
export async function claimTask(
  cwd: string,
  team: string,
  taskId: string,
  owner: string,
): Promise<{ task: TaskItem } | { rejected: true; reason: string }> {
  const fp = taskFilePath(cwd, team, taskId);

  // Strategy B: list lock for cross-task consistency
  const dir = getTasksDir(cwd, team);
  ensureDir(dir);
  const release = await acquireFileLock(listLockPath(cwd, team));
  try {
    // TOCTOU-safe: check existence inside the lock
    if (!fs.existsSync(fp)) {
      return { rejected: true, reason: "task_not_found" };
    }

    const task = JSON.parse(fs.readFileSync(fp, "utf-8")) as TaskItem;

    // Must be pending
    if (task.status !== "pending") {
      return { rejected: true, reason: `task_status_is_${task.status}` };
    }

    // Must be unowned (no agent has been assigned yet)
    if (task.owner != null) {
      return { rejected: true, reason: `already_owned_by_${task.owner}` };
    }

    // Check all blockers are completed.
    // Dangling references (blocker deleted) are treated as unblocked,
    // consistent with findAvailableTask's semantics.
    const allTasks = listTasks(cwd, team);
    for (const blockerId of task.blockedBy) {
      const blocker = allTasks.find(t => t.id === blockerId);
      if (!blocker) continue; // dangling → unblocked
      if (blocker.status !== "completed") {
        return { rejected: true, reason: `blocked_by_${blockerId}` };
      }
    }

    // Check agent is not already busy with another open task.
    // Use the registered callback if available (breaks circular dep on agent-status.ts),
    // otherwise fall back to inline logic.
    const isBusyCheck = _isAgentBusyFn
      ? _isAgentBusyFn(cwd, team, owner)
      : allTasks.some(t =>
          t.owner != null && t.owner === owner &&
          !isTerminalStatus(t.status) &&
          t.id !== taskId,
        );
    if (isBusyCheck) {
      return { rejected: true, reason: "agent_busy" };
    }

    // All checks passed — claim
    task.status = "in_progress";
    task.owner = owner;
    task.updatedAt = Date.now();
    writeTaskFile(cwd, team, task);
    return { task };
  } finally {
    await release();
  }
}

// ============================================================================
// Public API — Bidirectional Dependencies
// ============================================================================

/**
 * Establish a "A blocks B" relationship.
 * Atomically updates both A.blocks and B.blockedBy.
 * 
 * Validates: blocker must not be terminal, blocked must be pending.
 */
export async function blockTask(
  cwd: string,
  team: string,
  blockerId: string,
  blockedId: string,
): Promise<void> {
  const dir = getTasksDir(cwd, team);
  ensureDir(dir);
  const release = await acquireFileLock(listLockPath(cwd, team));
  try {
    // Self-dependency check
    if (blockerId === blockedId) {
      throw new Error(`Cannot block: task #${blockerId} cannot block itself`);
    }

    const blocker = readTaskFile(cwd, team, blockerId);
    const blocked = readTaskFile(cwd, team, blockedId);
    if (!blocker) throw new Error(`Task #${blockerId} not found`);
    if (!blocked) throw new Error(`Task #${blockedId} not found`);

    // Circular dependency check: walk the blocks graph from blockedId —
    // if we can reach blockerId, adding blocker→blocked would create a cycle.
    const allTasksMap = new Map(listTasks(cwd, team).map(t => [t.id, t]));
    if (wouldCreateCycle(allTasksMap, blockedId, blockerId)) {
      throw new Error(`Cannot block: would create circular dependency involving #${blockerId} and #${blockedId}`);
    }

    // Validation: terminal tasks should not block new tasks
    if (isTerminalStatus(blocker.status)) {
      // Completed blocker: dependency already satisfied, no-op
      if (blocker.status === "completed") return;
      // Failed/killed blocker: can't establish meaningful dependency
      throw new Error(
        `Cannot block: task #${blockerId} is in terminal state "${blocker.status}"`,
      );
    }

    // Validation: can only add dependencies to pending tasks
    if (blocked.status !== "pending") {
      throw new Error(
        `Cannot block: task #${blockedId} is "${blocked.status}" (must be pending)`,
      );
    }

    // Skip if already linked
    if (blocker.blocks.includes(blockedId) && blocked.blockedBy.includes(blockerId)) {
      return;
    }

    if (!blocker.blocks.includes(blockedId)) blocker.blocks.push(blockedId);
    if (!blocked.blockedBy.includes(blockerId)) blocked.blockedBy.push(blockerId);

    blocker.updatedAt = Date.now();
    blocked.updatedAt = Date.now();
    writeTaskFile(cwd, team, blocker);
    writeTaskFile(cwd, team, blocked);
  } finally {
    await release();
  }
}

/**
 * Remove a "A blocks B" relationship.
 * Atomically updates both A.blocks and B.blockedBy.
 */
export async function unblockTask(
  cwd: string,
  team: string,
  blockerId: string,
  blockedId: string,
): Promise<void> {
  const dir = getTasksDir(cwd, team);
  ensureDir(dir);
  const release = await acquireFileLock(listLockPath(cwd, team));
  try {
    const blocker = readTaskFile(cwd, team, blockerId);
    const blocked = readTaskFile(cwd, team, blockedId);

    if (blocker) {
      blocker.blocks = blocker.blocks.filter(id => id !== blockedId);
      blocker.updatedAt = Date.now();
      writeTaskFile(cwd, team, blocker);
    }
    if (blocked) {
      blocked.blockedBy = blocked.blockedBy.filter(id => id !== blockerId);
      blocked.updatedAt = Date.now();
      writeTaskFile(cwd, team, blocked);
    }
  } finally {
    await release();
  }
}

// ============================================================================
// Public API — Deletion (with dependency cleanup)
// ============================================================================

/**
 * Delete a task and clean up all dependency references.
 * - Removes the task's file
 * - Removes this task's ID from all other tasks' blocks[] and blockedBy[]
 * - Preserves the high-water mark (never reuse IDs)
 * 
 * Note: this intentionally modifies terminal-state tasks' blocks/blockedBy
 * and updatedAt fields — this is reference cleanup (not a business mutation),
 * ensuring no dangling dependency pointers after deletion.
 */
export async function deleteTask(
  cwd: string,
  team: string,
  taskId: string,
  options?: { force?: boolean },
): Promise<boolean> {
  const dir = getTasksDir(cwd, team);
  if (!fs.existsSync(dir)) return false;

  // Post-lock actions: executed after the lock is released to avoid deadlocks
  // (same pattern as updateTask).
  const postLockActions: (() => Promise<void>)[] = [];
  let wasForceKilled = false;
  let deletedTaskOwner: string | undefined;

  const release = await acquireFileLock(listLockPath(cwd, team));
  try {
    // TOCTOU-safe: check existence inside the lock
    const fp = taskFilePath(cwd, team, taskId);

    // Terminal state protection: reject deletion of non-terminal tasks unless force
    const task = readTaskFile(cwd, team, taskId);
    if (!task) return false;
    if (!isTerminalStatus(task.status)) {
      if (!options?.force) {
        throw new Error(`Cannot delete task #${taskId}: status is "${task.status}" (use force to override)`);
      }
      // Force-deleting a non-terminal task: mark as killed first so that
      // notifications and failure propagation run. We write directly to disk
      // (bypassing updateTask to avoid re-acquiring the same lock) and let
      // the caller handle worker termination if needed.
      task.status = "killed";
      task.metadata = { ...task.metadata, killReason: "force_deleted" };
      task.updatedAt = Date.now();
      wasForceKilled = true;
      deletedTaskOwner = task.owner ?? undefined;
    }
    // Clean up references in other tasks.
    // Note: we intentionally modify terminal-state tasks here — this is
    // reference cleanup (not a business mutation), ensuring no dangling
    // blockedBy/blocks pointers after deletion.
    const allTasks = listTasks(cwd, team);
    for (const other of allTasks) {
      if (other.id === taskId) continue;
      let modified = false;

      if (other.blocks.includes(taskId)) {
        other.blocks = other.blocks.filter(id => id !== taskId);
        modified = true;
      }
      if (other.blockedBy.includes(taskId)) {
        other.blockedBy = other.blockedBy.filter(id => id !== taskId);
        modified = true;
      }

      if (modified) {
        // Use refsCleanedAt instead of updatedAt to avoid affecting
        // stale/orphan detection that relies on updatedAt.
        other.refsCleanedAt = Date.now();
        writeTaskFile(cwd, team, other);
      }
    }

    // Delete the task file (high-water mark is preserved)
    try { fs.unlinkSync(fp); } catch { return false; }

    // Schedule post-lock actions for force-killed tasks.
    // These must run outside the lock to avoid deadlocks (same pattern as updateTask).
    if (wasForceKilled) {
      const owner = deletedTaskOwner;
      postLockActions.push(() => propagateFailureToBlocked(cwd, team, taskId));
      if (owner) {
        postLockActions.push(async () => {
          try {
            await writeToMailbox(cwd, owner, {
              from: "task-system",
              text: JSON.stringify({ type: "task_failed", taskId, failedBy: "force_delete", reason: "Task force-deleted" } as TaskNotification),
              timestamp: new Date().toISOString(),
            }, team);
          } catch (err) {
            console.warn(`[aim] Failed to notify owner of force-deleted task #${taskId}:`, err);
          }
        });
      }
      // Notify team leader
      postLockActions.push(async () => {
        try {
          await writeToMailbox(cwd, "team-lead", {
            from: "task-system",
            text: JSON.stringify({ type: "task_failed", taskId, failedBy: "force_delete", reason: "Task force-deleted" } as TaskNotification),
            timestamp: new Date().toISOString(),
          }, team);
        } catch (err) {
          console.warn(`[aim] Failed to notify team-lead of force-deleted task #${taskId}:`, err);
        }
      });
    }

    return true;
  } finally {
    await release();
  }

  // Execute post-lock actions outside the critical section.
  // Errors here are non-fatal — the task deletion itself has already succeeded.
  for (const action of postLockActions) {
    try {
      await action();
    } catch (err) {
      console.warn(`[aim] Post-lock action failed for force-deleted task #${taskId}:`, err);
    }
  }
}

// ============================================================================
// Public API — Infrastructure-Level Operations
// ============================================================================

/**
 * Force-set a task's status to a terminal state, bypassing hooks.
 *
 * This is an infrastructure-level safety valve for situations where normal
 * updateTask would be vetoed by hooks (e.g. a completion hook that requires
 * verification, but the worker has already gone idle and can't verify).
 *
 * Still acquires the list lock, validates state transitions, and triggers
 * post-lock side effects (notifications, failure propagation). Only the hook
 * execution is skipped.
 *
 * @returns The updated task, or null if the task doesn't exist or is already terminal.
 */
export async function forceTaskStatus(
  cwd: string,
  team: string,
  taskId: string,
  status: "failed" | "killed",
  reason?: string,
): Promise<TaskItem | null> {
  const updates: Partial<Pick<TaskItem, "status" | "metadata">> = { status };
  if (reason) {
    updates.metadata = { forceReason: reason };
  }
  return updateTask(cwd, team, taskId, updates, { skipHooks: true });
}

// ============================================================================
// Public API — Queries (advanced, no lock)
// ============================================================================

/** Find the next available (pending, unblocked, unowned) task.
 *
 *  No lock — read-only query (eventual consistency).
 *  Dangling blockedBy references (blocker deleted) are treated as unblocked.
 *  Dangling cleanup is handled by deleteTask(); we don't write here.
 */
export function findAvailableTask(cwd: string, team: string): TaskItem | null {
  const all = listTasks(cwd, team);
  const taskMap = new Map(all.map(t => [t.id, t]));
  return all.find(t =>
    t.status === "pending" &&
    !t.owner &&
    t.blockedBy.every(bid => {
      const blocker = taskMap.get(bid);
      // Blocker doesn't exist → dangling reference, treat as unblocked
      // (deleteTask should have cleaned it up, but be defensive)
      if (!blocker) return true;
      // Blocker is terminal (completed/failed/killed) → unblocked
      return isTerminalStatus(blocker.status);
    }),
  ) ?? null;
}

/**
 * Find all tasks that become unblocked after a given task completes.
 * Useful for notifying waiting agents.
 */
export function findUnblockedTasks(
  cwd: string,
  team: string,
  completedTaskId: string,
): TaskItem[] {
  const all = listTasks(cwd, team);
  const taskMap = new Map(all.map(t => [t.id, t]));
  return all.filter(t =>
    t.status === "pending" &&
    t.blockedBy.includes(completedTaskId) &&
    // All other blockers must also be terminal
    t.blockedBy.every(bid => {
      const blocker = taskMap.get(bid);
      // Blocker doesn't exist → dangling dependency, treat as unblocked
      // (deleteTask should have cleaned it up, but be defensive)
      if (!blocker) return true;
      return isTerminalStatus(blocker.status);
    }),
  );
}

/**
 * Check if an agent has any open (non-terminal) tasks.
 * Uses != null to match both null (legacy JSON) and undefined (current).
 */
export function isAgentBusy(cwd: string, team: string, agentName: string): boolean {
  const tasks = listTasks(cwd, team);
  return tasks.some(t =>
    t.owner != null && t.owner === agentName && !isTerminalStatus(t.status),
  );
}

/**
 * Get all tasks owned by a specific agent.
 * Uses != null to match both null (legacy JSON) and undefined (current).
 */
export function getAgentTasks(cwd: string, team: string, agentName: string): TaskItem[] {
  return listTasks(cwd, team).filter(t => t.owner != null && t.owner === agentName);
}

// ============================================================================
// Public API — Failure Propagation
// ============================================================================

/**
 * Propagate failure to all tasks blocked by a failed/killed task.
 *
 * When a blocker reaches a non-completed terminal state (failed or killed),
 * its dependent tasks cannot proceed — the dependency will never be satisfied.
 * Instead of just unblocking them (which would let them start work that is
 * doomed to fail), we cascade the failure.
 *
 * Uses BFS to collect ALL cascade-affected tasks in one pass, then writes
 * them in a single locked section. This avoids the previous recursive
 * approach that called updateTask() (which acquires the same list lock
 * → deadlock) and also avoids deep call stacks on long dependency chains.
 *
 * System-level cascade: failed transitions are written directly to disk
 * without running hooks, since this is infrastructure-level bookkeeping
 * (mirrors Claude Code's design where dependency failure cascades bypass hooks).
 */
async function propagateFailureToBlocked(
  cwd: string,
  team: string,
  failedTaskId: string,
): Promise<void> {
  // Phase 1: BFS to collect all cascade-affected tasks (no lock needed — read-only)
  //
  // NOTE: The allTasks snapshot is taken outside the lock. Between Phase 1 and Phase 2,
  // other processes may modify task files. This is acceptable because:
  //   - Phase 2 re-reads each task file inside the lock (readTaskFile), so it uses
  //     fresh data for the actual write.
  //   - If a task that was "toFail" in Phase 1 has already been completed/killed by
  //     Phase 2, the isTerminalStatus check will skip it safely.
  //   - In extreme concurrency, a task that was pending in Phase 1 but became
  //     in_progress by Phase 2 will still be cascade-failed — this is correct
  //     because its dependency will never be satisfied.
  const allTasks = listTasks(cwd, team);
  const taskMap = new Map(allTasks.map(t => [t.id, t]));
  const failedTask = taskMap.get(failedTaskId);
  if (!failedTask || failedTask.blocks.length === 0) return;

  const toFail: { id: string; reason: string }[] = [];
  const toNotifyUnblocked: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [failedTaskId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const current = taskMap.get(currentId);
    if (!current) continue;

    for (const blockedId of current.blocks) {
      if (visited.has(blockedId)) continue;
      const blocked = taskMap.get(blockedId);
      if (!blocked || blocked.status !== "pending") continue;

      // Check ALL blockers for this task
      let allTerminal = true;
      let hasFailedBlocker = false;
      for (const bid of blocked.blockedBy) {
        const blocker = taskMap.get(bid);
        if (!blocker) continue; // dangling → treat as unblocked
        if (!isTerminalStatus(blocker.status)) {
          allTerminal = false;
          break;
        }
        if (blocker.status !== "completed") {
          hasFailedBlocker = true;
        }
      }

      if (allTerminal && hasFailedBlocker) {
        // Cascade failure — will be written in batch below
        toFail.push({ id: blockedId, reason: `Dependency #${failedTaskId} failed` });
        // Continue BFS: this newly-failed task may block others
        queue.push(blockedId);
      } else if (allTerminal && !hasFailedBlocker) {
        // All blockers completed successfully → task is fully unblocked
        toNotifyUnblocked.push(blockedId);
      }
    }
  }

  if (toFail.length === 0 && toNotifyUnblocked.length === 0) return;

  // Phase 2: Batch write all cascade failures under a single lock acquisition.
  // Also capture a fresh task snapshot inside the lock for Phase 3 notifications.
  // This ensures notifications use consistent data, not the potentially-stale
  // allTasks from Phase 1's lockless BFS scan.
  let freshSnapshot: TaskItem[] = [];
  const dir = getTasksDir(cwd, team);
  ensureDir(dir);
  const release = await acquireFileLock(listLockPath(cwd, team));
  try {
    for (const item of toFail) {
      // Re-read fresh state inside the lock (may have changed since BFS scan)
      const fresh = readTaskFile(cwd, team, item.id);
      if (!fresh) continue;
      // Skip terminal tasks (already completed/failed/killed)
      if (isTerminalStatus(fresh.status)) continue;
      // Skip in_progress tasks — they have an active agent working on them.
      // Cascading failure to an active agent is jarring (they get task_claimed
      // then immediately task_failed). Let the stale task cleanup handle these
      // instead, since the agent will discover the failed dependency on its own.
      if (fresh.status === "in_progress") {
        console.info(`[aim] Skipping cascade for in-progress task #${item.id} (dependency #${failedTaskId} failed). Stale cleanup will handle it.`);
        continue;
      }
      // Only cascade-fail pending tasks — they haven't been claimed yet.
      fresh.status = "failed";
      fresh.metadata = { ...fresh.metadata, failureReason: item.reason };
      fresh.updatedAt = Date.now();
      writeTaskFile(cwd, team, fresh);
    }
    // Capture fresh snapshot inside the lock for notification accuracy
    freshSnapshot = listTasks(cwd, team);
  } finally {
    await release();
  }

  // Phase 3: Send notifications (outside the lock) using the fresh snapshot
  for (const unblockedId of toNotifyUnblocked) {
    const candidate = _findCandidateAgentFn?.(cwd, team);
    try { await notifyTaskUnblocked(cwd, team, unblockedId, freshSnapshot, candidate); } catch (err) {
      console.warn(`[aim] Failed to notify unblocked task #${unblockedId}:`, err);
    }
  }

  // Notify owners of cascade-failed tasks
  // Use the fresh snapshot to get accurate owner info
  const freshTaskMap = new Map(freshSnapshot.map(t => [t.id, t]));
  for (const item of toFail) {
    const task = freshTaskMap.get(item.id);
    if (task?.owner) {
      try {
        const notif: TaskNotification = {
          type: "task_failed",
          taskId: item.id,
          failedBy: failedTaskId,
          reason: item.reason,
        };
        await writeToMailbox(cwd, task.owner, {
          from: "task-system",
          text: JSON.stringify(notif),
          timestamp: new Date().toISOString(),
        }, team);
      } catch (err) {
        console.warn(`[aim] Failed to notify owner of failed task #${item.id}:`, err);
      }
    }
  }
}

/**
 * Clean up stale in-progress tasks.
 *
 * Tasks that have been in_progress for longer than `maxAgeMs` are likely
 * orphaned (the agent processing them crashed or disconnected). This function
 * transitions them to "killed" status so they can be deleted or reclaimed.
 *
 * This mirrors Claude Code's orphan detection mechanism.
 *
 * @param maxAgeMs Maximum age in milliseconds for an in_progress task.
 *   Default: 30 minutes (1_800_000 ms).
 * @returns Number of tasks that were cleaned up.
 */
export async function cleanupStaleTasks(
  cwd: string,
  team: string,
  maxAgeMs = 1_800_000, // 30 minutes
  options?: { autoDelete?: boolean },
): Promise<number> {
  const now = Date.now();
  const tasks = listTasks(cwd, team);
  let cleaned = 0;

  for (const task of tasks) {
    if (task.status !== "in_progress") continue;
    const age = now - task.updatedAt;
    if (age > maxAgeMs) {
      try {
        // Use forceTaskStatus (skipHooks=true) for infrastructure-level cleanup.
        // Stale task cleanup is a system operation — hooks should not be able to
        // prevent orphaned tasks from being cleaned up, otherwise they stay
        // in_progress forever.
        await forceTaskStatus(cwd, team, task.id, "killed", `stale (age: ${Math.round(age / 60000)}m)`);
        if (options?.autoDelete) {
          await deleteTask(cwd, team, task.id, { force: true });
        }
        cleaned++;
      } catch (err) {
        // forceTaskStatus should not fail due to hook veto (skipHooks=true),
        // but other errors (file I/O, lock timeout) can still occur.
        console.warn(`[aim] Failed to clean up stale task #${task.id}:`, err);
      }
    }
  }

  return cleaned;
}

// ============================================================================
// P1: Re-export hook types for convenience
// ============================================================================

export {
  registerTaskCreatedHook,
  registerTaskCompletedHook,
  registerTaskTransitionHook,
  type HookResult,
  type HookContext,
  type TaskCreatedHook,
  type TaskCompletedHook,
  type TaskTransitionHook,
} from "./task-hooks.ts";

// ============================================================================
// P0/P1: Re-export options & infrastructure types
// ============================================================================

// Types UpdateTaskOptions, FindCandidateAgentFn, IsAgentBusyFn are already exported at definition site.

