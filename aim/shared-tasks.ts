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
 *
 * Refactor: the fifteen public functions all threaded `(cwd, team, ...)` and
 * shared a set of internal helpers that re-threaded the same pair. They are
 * now methods on `TaskStore` (cwd + team bound at construction), so internal
 * helpers and cross-method calls no longer thread context. Thin function
 * facades are re-exported for backward compatibility (other extensions and
 * index.ts's public API depend on them).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  getTasksDir,
  sanitizeId,
  isTerminalStatus,
  canTransition,
  VALID_TRANSITIONS,
  type TaskItem,
  type TaskStatus,
  type TaskType,
} from "./types.js";

import {
  executeTaskCreatedHooks,
  executeTaskCompletedHooks,
  executeTaskTransitionHooks,
  type HookContext,
} from "./task-hooks.js";
import { notifyTaskUnblocked, nudgeVerification, notifyTaskAssignment, notifyTaskCompleted, type TaskNotification } from "./task-notifications.js";
import { writeToMailbox } from "./mailbox.js";
import { acquireFileLock } from "./lock.js";

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

/** Options for creating a new task */
export interface CreateTaskOptions {
  type?: TaskType;
  activeForm?: string;
  blockedBy?: string[];
  metadata?: Record<string, unknown>;
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

/** Callback type for checking if an agent process is still alive.
 *  Registered by the extension entry point (index.ts) to break the circular
 *  dependency: shared-tasks.ts ↔ worker-pool.ts. */
export type IsAgentAliveFn = (agentId: string) => boolean;

let _isAgentAliveFn: IsAgentAliveFn | null = null;

/** Register a callback to check if an agent process is still alive.
 *  Called by cleanupStaleTasks to skip tasks whose owner process is still
 *  running (avoiding false-positive orphan detection on long-running tasks). */
export function registerIsAgentAlive(fn: IsAgentAliveFn): void {
  _isAgentAliveFn = fn;
}

/** Callback type for finding a candidate agent for unowned unblocked tasks.
 *  Registered by the extension entry point (index.ts) to break the circular
 *  dependency: shared-tasks.ts ↔ agent-status.ts */
export type FindCandidateAgentFn = (cwd: string, team: string) => string | undefined;

let _findCandidateAgentFn: FindCandidateAgentFn | null = null;

/** Register a callback to find a candidate agent for unowned unblocked tasks. */
export function registerFindCandidateAgent(fn: FindCandidateAgentFn): void {
  _findCandidateAgentFn = fn;
}

// Re-export for convenience
export { isTerminalStatus, canTransition, VALID_TRANSITIONS, type TaskItem, type TaskStatus, type TaskType };

// ============================================================================
// TaskStore Class
// ============================================================================

const HIGHWATERMARK_FILE = ".highwatermark";

/**
 * File-based shared task list for a single (cwd, team) context.
 *
 * All task operations are methods on this class; cwd and team are bound at
 * construction so callers stop threading them through every call. The class
 * also owns the internal I/O helpers (read/write task file, high-water mark,
 * list lock path) which previously re-threaded the same context pair.
 *
 * Lock strategy (Strategy B — dual-layer):
 *   - Read operations: no lock (eventual consistency)
 *   - All write operations: list lock (.list.lock)
 */
export class TaskStore {
  constructor(
    private readonly cwd: string,
    private readonly team: string,
  ) {}

  // ── I/O Helpers (private) ──

  private ensureDir(dir: string): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }
  }

  private taskFilePath(taskId: string): string {
    return path.join(getTasksDir(this.cwd, this.team), `task-${sanitizeId(taskId, "task id")}.json`);
  }

  /** Get the list lock path for this team's task directory */
  private listLockPath(): string {
    return path.join(getTasksDir(this.cwd, this.team), ".list.lock");
  }

  private readHighwaterMark(dir: string): number {
    const fp = path.join(dir, HIGHWATERMARK_FILE);
    try {
      return Number(fs.readFileSync(fp, "utf-8")) || 0;
    } catch {
      return 0;
    }
  }

  private writeHighwaterMark(dir: string, mark: number): void {
    fs.writeFileSync(path.join(dir, HIGHWATERMARK_FILE), String(mark));
  }

  /** Read a single task file, returns null if not found or invalid */
  private readTaskFile(taskId: string): TaskItem | null {
    const fp = this.taskFilePath(taskId);
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
  private writeTaskFile(task: TaskItem): void {
    const fp = this.taskFilePath(task.id);
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

  /**
   * Check if adding an edge from blockerId→blockedId would create a cycle
   * in the blocks graph.
   */
  private wouldCreateCycle(
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

  // ── Public Queries (no lock — eventual consistency) ──

  /** Read all tasks for the team, sorted by ID (numeric ascending). */
  listTasks(): TaskItem[] {
    const dir = getTasksDir(this.cwd, this.team);
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
  getTask(taskId: string): TaskItem | null {
    return this.readTaskFile(taskId);
  }

  // ── Public Mutations (all use list lock — Strategy B) ──

  /**
   * Create a new task.
   * Uses high-water mark to prevent ID reuse.
   * If blockedBy is specified, auto-maintains the reverse blocks[] on each blocker.
   */
  async createTask(
    subject: string,
    description = "",
    options?: CreateTaskOptions,
  ): Promise<TaskItem> {
    const dir = getTasksDir(this.cwd, this.team);
    this.ensureDir(dir);
    const release = await acquireFileLock(this.listLockPath());
    try {
      // High-water mark: always increment, never reuse
      const hwm = this.readHighwaterMark(dir);
      const nextId = String(hwm + 1);
      this.writeHighwaterMark(dir, hwm + 1);

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
      if (task.blockedBy.length > 0) {
        for (const blockerId of task.blockedBy) {
          const blocker = this.readTaskFile(blockerId);
          if (!blocker) {
            throw new Error(`Cannot create task: blocker #${blockerId} does not exist`);
          }
        }
      }

      this.writeTaskFile(task);

      // Maintain reverse blocks[] references on blockers.
      if (task.blockedBy.length > 0) {
        for (const blockerId of task.blockedBy) {
          const blocker = this.readTaskFile(blockerId);
          if (!blocker) continue;
          if (!isTerminalStatus(blocker.status) && !blocker.blocks.includes(nextId)) {
            blocker.blocks.push(nextId);
            blocker.updatedAt = Date.now();
            this.writeTaskFile(blocker);
          }
        }
      }

      // P1: Execute created hooks — if any hook vetos, delete the task and throw
      const hookCtx: HookContext = { cwd: this.cwd, team: this.team };
      const hookResult = await executeTaskCreatedHooks(task, hookCtx);
      if (!hookResult.allowed) {
        // Rollback: delete task file, clean up blocker references.
        const rollbackErrors: string[] = [];
        try { fs.unlinkSync(this.taskFilePath(nextId)); } catch (e: any) {
          rollbackErrors.push(`Failed to delete task file: ${e.message}`);
        }
        for (const blockerId of task.blockedBy) {
          try {
            const blocker = this.readTaskFile(blockerId);
            if (blocker) {
              blocker.blocks = blocker.blocks.filter(id => id !== nextId);
              blocker.updatedAt = Date.now();
              this.writeTaskFile(blocker);
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
   */
  async updateTask(
    taskId: string,
    updates: Partial<Pick<TaskItem, "status" | "owner" | "description" | "activeForm" | "metadata">>,
    options?: UpdateTaskOptions,
  ): Promise<TaskItem | null> {
    // Post-lock actions: collected during the locked section, executed after
    // the lock is released. This prevents deadlocks when notifications or
    // failure propagation need to acquire the same list lock.
    const postLockActions: (() => Promise<void>)[] = [];
    let result: TaskItem | null = null;

    const release = await acquireFileLock(this.listLockPath());
    try {
      // TOCTOU-safe: check existence inside the lock
      const fp = this.taskFilePath(taskId);
      if (!fs.existsSync(fp)) return null;

      const task = JSON.parse(fs.readFileSync(fp, "utf-8")) as TaskItem;

      // Terminal state protection: reject business-field mutations on completed/failed/killed tasks.
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
          this.writeTaskFile(task);
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

        if (!options?.skipHooks) {
          const hookCtx: HookContext = { cwd: this.cwd, team: this.team };

          // P1: Execute completed hooks FIRST for terminal transitions.
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

      this.writeTaskFile(task);
      result = task;

      // Collect post-lock side effects (notifications, propagation).
      if (updates.owner !== undefined && updates.owner !== previousOwner && !isTerminalStatus(task.status)) {
        const owner = updates.owner;
        const subject = task.subject;
        postLockActions.push(() => notifyTaskAssignment(this.cwd, owner, this.team, taskId, subject, "team-lead"));
      }

      if (isTerminalStatus(task.status)) {
        // Capture task snapshot inside lock for consistent view.
        const taskSnapshot = this.listTasks();
        const ownerForNotif = task.owner ?? "unknown";

        if (task.status === "completed") {
          // Find candidate agent for unowned unblocked tasks (breaks circular dep on agent-status.ts)
          const candidateAgent = _findCandidateAgentFn?.(this.cwd, this.team);
          postLockActions.push(() => notifyTaskUnblocked(this.cwd, this.team, taskId, taskSnapshot, candidateAgent));
          postLockActions.push(() => nudgeVerification(this.cwd, this.team, taskSnapshot));
          // Notify team leader that this task completed (for coordinator awareness)
          postLockActions.push(() => notifyTaskCompleted(this.cwd, this.team, taskId, ownerForNotif));
        } else {
          postLockActions.push(() => this.propagateFailureToBlocked(taskId));
        }
      }
    } finally {
      await release();
    }

    // Execute post-lock actions outside the critical section.
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
   * Returns the claimed task, or a rejection reason.
   */
  async claimTask(
    taskId: string,
    owner: string,
  ): Promise<{ task: TaskItem } | { rejected: true; reason: string }> {
    const fp = this.taskFilePath(taskId);

    const dir = getTasksDir(this.cwd, this.team);
    this.ensureDir(dir);
    const release = await acquireFileLock(this.listLockPath());
    try {
      if (!fs.existsSync(fp)) {
        return { rejected: true, reason: "task_not_found" };
      }

      const task = JSON.parse(fs.readFileSync(fp, "utf-8")) as TaskItem;

      if (task.status !== "pending") {
        return { rejected: true, reason: `task_status_is_${task.status}` };
      }

      if (task.owner != null) {
        return { rejected: true, reason: `already_owned_by_${task.owner}` };
      }

      // Check all blockers are completed.
      const allTasks = this.listTasks();
      for (const blockerId of task.blockedBy) {
        const blocker = allTasks.find(t => t.id === blockerId);
        if (!blocker) continue;
        if (blocker.status !== "completed") {
          return { rejected: true, reason: `blocked_by_${blockerId}` };
        }
      }

      // Check agent is not already busy with another open task.
      const isBusyCheck = _isAgentBusyFn
        ? _isAgentBusyFn(this.cwd, this.team, owner)
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
      this.writeTaskFile(task);
      return { task };
    } finally {
      await release();
    }
  }

  // ── Bidirectional Dependencies ──

  /** Establish a "A blocks B" relationship. Atomically updates both sides. */
  async blockTask(blockerId: string, blockedId: string): Promise<void> {
    const dir = getTasksDir(this.cwd, this.team);
    this.ensureDir(dir);
    const release = await acquireFileLock(this.listLockPath());
    try {
      if (blockerId === blockedId) {
        throw new Error(`Cannot block: task #${blockerId} cannot block itself`);
      }

      const blocker = this.readTaskFile(blockerId);
      const blocked = this.readTaskFile(blockedId);
      if (!blocker) throw new Error(`Task #${blockerId} not found`);
      if (!blocked) throw new Error(`Task #${blockedId} not found`);

      // Circular dependency check
      const allTasksMap = new Map(this.listTasks().map(t => [t.id, t]));
      if (this.wouldCreateCycle(allTasksMap, blockedId, blockerId)) {
        throw new Error(`Cannot block: would create circular dependency involving #${blockerId} and #${blockedId}`);
      }

      if (isTerminalStatus(blocker.status)) {
        if (blocker.status === "completed") return;
        throw new Error(
          `Cannot block: task #${blockerId} is in terminal state "${blocker.status}"`,
        );
      }

      if (blocked.status !== "pending") {
        throw new Error(
          `Cannot block: task #${blockedId} is "${blocked.status}" (must be pending)`,
        );
      }

      if (blocker.blocks.includes(blockedId) && blocked.blockedBy.includes(blockerId)) {
        return;
      }

      if (!blocker.blocks.includes(blockedId)) blocker.blocks.push(blockedId);
      if (!blocked.blockedBy.includes(blockerId)) blocked.blockedBy.push(blockerId);

      blocker.updatedAt = Date.now();
      blocked.updatedAt = Date.now();
      this.writeTaskFile(blocker);
      this.writeTaskFile(blocked);
    } finally {
      await release();
    }
  }

  /** Remove a "A blocks B" relationship. Atomically updates both sides. */
  async unblockTask(blockerId: string, blockedId: string): Promise<void> {
    const dir = getTasksDir(this.cwd, this.team);
    this.ensureDir(dir);
    const release = await acquireFileLock(this.listLockPath());
    try {
      const blocker = this.readTaskFile(blockerId);
      const blocked = this.readTaskFile(blockedId);

      if (blocker) {
        blocker.blocks = blocker.blocks.filter(id => id !== blockedId);
        blocker.updatedAt = Date.now();
        this.writeTaskFile(blocker);
      }
      if (blocked) {
        blocked.blockedBy = blocked.blockedBy.filter(id => id !== blockerId);
        blocked.updatedAt = Date.now();
        this.writeTaskFile(blocked);
      }
    } finally {
      await release();
    }
  }

  // ── Deletion (with dependency cleanup) ──

  /**
   * Delete a task and clean up all dependency references.
   * - Removes the task's file
   * - Removes this task's ID from all other tasks' blocks[] and blockedBy[]
   * - Preserves the high-water mark (never reuse IDs)
   */
  async deleteTask(
    taskId: string,
    options?: { force?: boolean },
  ): Promise<boolean> {
    const dir = getTasksDir(this.cwd, this.team);
    if (!fs.existsSync(dir)) return false;

    const postLockActions: (() => Promise<void>)[] = [];
    let wasForceKilled = false;
    let deletedTaskOwner: string | undefined;
    let deletedTaskBlocks: string[] = [];

    const release = await acquireFileLock(this.listLockPath());
    try {
      const fp = this.taskFilePath(taskId);

      const task = this.readTaskFile(taskId);
      if (!task) return false;
      if (!isTerminalStatus(task.status)) {
        if (!options?.force) {
          throw new Error(`Cannot delete task #${taskId}: status is "${task.status}" (use force to override)`);
        }
        task.status = "killed";
        task.metadata = { ...task.metadata, killReason: "force_deleted" };
        task.updatedAt = Date.now();
        wasForceKilled = true;
        deletedTaskOwner = task.owner ?? undefined;
      }
      // Clean up references in other tasks.
      const allTasks = this.listTasks();
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
          this.writeTaskFile(other);
        }
      }

      try { fs.unlinkSync(fp); } catch { return false; }

      if (wasForceKilled) {
        const owner = deletedTaskOwner;
        const team = this.team;
        const cwd = this.cwd;
        postLockActions.push(() => this.propagateFailureToBlocked(taskId, deletedTaskBlocks));
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

    for (const action of postLockActions) {
      try {
        await action();
      } catch (err) {
        console.warn(`[aim] Post-lock action failed for force-deleted task #${taskId}:`, err);
        }
    }
  }

  // ── Infrastructure-Level Operations ──

  /**
   * Force-set a task's status to a terminal state, bypassing hooks.
   * Infrastructure-level safety valve for situations where normal updateTask
   * would be vetoed by hooks.
   */
  async forceTaskStatus(
    taskId: string,
    status: "failed" | "killed",
    reason?: string,
  ): Promise<TaskItem | null> {
    const updates: Partial<Pick<TaskItem, "status" | "metadata">> = { status };
    if (reason) {
      updates.metadata = { forceReason: reason };
    }
    return this.updateTask(taskId, updates, { skipHooks: true });
  }

  // ── Advanced Queries (no lock) ──

  /** Find the next available (pending, unblocked, unowned) task. */
  findAvailableTask(): TaskItem | null {
    const all = this.listTasks();
    const taskMap = new Map(all.map(t => [t.id, t]));
    return all.find(t =>
      t.status === "pending" &&
      !t.owner &&
      t.blockedBy.every(bid => {
        const blocker = taskMap.get(bid);
        if (!blocker) return true;
        return isTerminalStatus(blocker.status);
      }),
    ) ?? null;
  }

  /** Find all tasks that become unblocked after a given task completes. */
  findUnblockedTasks(completedTaskId: string): TaskItem[] {
    const all = this.listTasks();
    const taskMap = new Map(all.map(t => [t.id, t]));
    return all.filter(t =>
      t.status === "pending" &&
      t.blockedBy.includes(completedTaskId) &&
      t.blockedBy.every(bid => {
        const blocker = taskMap.get(bid);
        if (!blocker) return true;
        return isTerminalStatus(blocker.status);
      }),
    );
  }

  /** Check if an agent has any open (non-terminal) tasks. */
  isAgentBusy(agentName: string): boolean {
    const tasks = this.listTasks();
    return tasks.some(t =>
      t.owner != null && t.owner === agentName && !isTerminalStatus(t.status),
    );
  }

  /** Get all tasks owned by a specific agent. */
  getAgentTasks(agentName: string): TaskItem[] {
    return this.listTasks().filter(t => t.owner != null && t.owner === agentName);
  }

  // ── Failure Propagation (internal) ──

  /**
   * Propagate failure to all tasks blocked by a failed/killed task.
   * Uses BFS to collect ALL cascade-affected tasks in one pass, then writes
   * them in a single locked section. Bypasses hooks (infrastructure bookkeeping).
   */
  private async propagateFailureToBlocked(
    failedTaskId: string,
    preloadedBlocks?: string[],
  ): Promise<void> {
    const allTasks = this.listTasks();
    const taskMap = new Map(allTasks.map(t => [t.id, t]));
    const failedTask = taskMap.get(failedTaskId) ?? (preloadedBlocks
      ? { id: failedTaskId, blocks: preloadedBlocks, status: "failed" as TaskStatus }
      : undefined);
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

        let allTerminal = true;
        let hasFailedBlocker = false;
        for (const bid of blocked.blockedBy) {
          const blocker = taskMap.get(bid);
          if (!blocker) continue;
          if (!isTerminalStatus(blocker.status)) {
            allTerminal = false;
            break;
          }
          if (blocker.status !== "completed") {
            hasFailedBlocker = true;
          }
        }

        if (allTerminal && hasFailedBlocker) {
          toFail.push({ id: blockedId, reason: `Dependency #${failedTaskId} failed` });
          queue.push(blockedId);
        } else if (allTerminal && !hasFailedBlocker) {
          toNotifyUnblocked.push(blockedId);
        }
      }
    }

    if (toFail.length === 0 && toNotifyUnblocked.length === 0) return;

    let freshSnapshot: TaskItem[] = [];
    const dir = getTasksDir(this.cwd, this.team);
    this.ensureDir(dir);
    const release = await acquireFileLock(this.listLockPath());
    try {
      for (const item of toFail) {
        const fresh = this.readTaskFile(item.id);
        if (!fresh) continue;
        if (isTerminalStatus(fresh.status)) continue;
        if (fresh.status === "in_progress") {
          console.info(`[aim] Skipping cascade for in-progress task #${item.id} (dependency #${failedTaskId} failed). Stale cleanup will handle it.`);
          continue;
        }
        fresh.status = "failed";
        fresh.metadata = { ...fresh.metadata, failureReason: item.reason };
        fresh.updatedAt = Date.now();
        this.writeTaskFile(fresh);
      }
      freshSnapshot = this.listTasks();
    } finally {
      await release();
    }

    // Phase 3: Send notifications (outside the lock) using the fresh snapshot
    for (const unblockedId of toNotifyUnblocked) {
      const candidate = _findCandidateAgentFn?.(this.cwd, this.team);
      try { await notifyTaskUnblocked(this.cwd, this.team, unblockedId, freshSnapshot, candidate); } catch (err) {
        console.warn(`[aim] Failed to notify unblocked task #${unblockedId}:`, err);
      }
    }

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
          await writeToMailbox(this.cwd, task.owner, {
            from: "task-system",
            text: JSON.stringify(notif),
            timestamp: new Date().toISOString(),
          }, this.team);
        } catch (err) {
          console.warn(`[aim] Failed to notify owner of failed task #${item.id}:`, err);
        }
      }
    }
  }

  // ── Stale Task Cleanup ──

  /**
   * Clean up stale in-progress tasks. Tasks in_progress longer than maxAgeMs
   * are likely orphaned → transitioned to "killed".
   */
  async cleanupStaleTasks(
    maxAgeMs = 1_800_000, // 30 minutes
    options?: { autoDelete?: boolean },
  ): Promise<number> {
    const now = Date.now();
    const tasks = this.listTasks();
    let cleaned = 0;

    for (const task of tasks) {
      if (task.status !== "in_progress") continue;
      const age = now - task.updatedAt;
      if (age > maxAgeMs) {
        // G2: avoid false-positive orphan detection. If the owning agent's
        // process is still alive, the task is healthy (just long-running).
        const ownerAgentId = (task.metadata?.agentId as string | undefined) ?? task.owner;
        if (ownerAgentId && _isAgentAliveFn?.(ownerAgentId)) {
          continue;
        }
        try {
          await this.forceTaskStatus(task.id, "killed", `stale (age: ${Math.round(age / 60000)}m)`);
          if (options?.autoDelete) {
            await this.deleteTask(task.id, { force: true });
          }
          cleaned++;
        } catch (err) {
          console.warn(`[aim] Failed to clean up stale task #${task.id}:`, err);
        }
      }
    }

    return cleaned;
  }
}

// ============================================================================
// Backward-Compatible Functional API (thin facades over TaskStore)
// ============================================================================
// These preserve the public function signatures that index.ts re-exports and
// that other extensions may depend on. Each delegates to a fresh TaskStore.

export function listTasks(cwd: string, team: string): TaskItem[] {
  return new TaskStore(cwd, team).listTasks();
}

export function getTask(cwd: string, team: string, taskId: string): TaskItem | null {
  return new TaskStore(cwd, team).getTask(taskId);
}

export async function createTask(
  cwd: string,
  team: string,
  subject: string,
  description = "",
  options?: CreateTaskOptions,
): Promise<TaskItem> {
  return new TaskStore(cwd, team).createTask(subject, description, options);
}

export async function updateTask(
  cwd: string,
  team: string,
  taskId: string,
  updates: Partial<Pick<TaskItem, "status" | "owner" | "description" | "activeForm" | "metadata">>,
  options?: UpdateTaskOptions,
): Promise<TaskItem | null> {
  return new TaskStore(cwd, team).updateTask(taskId, updates, options);
}

export async function claimTask(
  cwd: string,
  team: string,
  taskId: string,
  owner: string,
): Promise<{ task: TaskItem } | { rejected: true; reason: string }> {
  return new TaskStore(cwd, team).claimTask(taskId, owner);
}

export async function deleteTask(
  cwd: string,
  team: string,
  taskId: string,
  options?: { force?: boolean },
): Promise<boolean> {
  return new TaskStore(cwd, team).deleteTask(taskId, options);
}

export async function forceTaskStatus(
  cwd: string,
  team: string,
  taskId: string,
  status: "failed" | "killed",
  reason?: string,
): Promise<TaskItem | null> {
  return new TaskStore(cwd, team).forceTaskStatus(taskId, status, reason);
}

export async function blockTask(
  cwd: string,
  team: string,
  blockerId: string,
  blockedId: string,
): Promise<void> {
  return new TaskStore(cwd, team).blockTask(blockerId, blockedId);
}

export async function unblockTask(
  cwd: string,
  team: string,
  blockerId: string,
  blockedId: string,
): Promise<void> {
  return new TaskStore(cwd, team).unblockTask(blockerId, blockedId);
}

export function findAvailableTask(cwd: string, team: string): TaskItem | null {
  return new TaskStore(cwd, team).findAvailableTask();
}

export function findUnblockedTasks(
  cwd: string,
  team: string,
  completedTaskId: string,
): TaskItem[] {
  return new TaskStore(cwd, team).findUnblockedTasks(completedTaskId);
}

export function isAgentBusy(cwd: string, team: string, agentName: string): boolean {
  return new TaskStore(cwd, team).isAgentBusy(agentName);
}

export function getAgentTasks(cwd: string, team: string, agentName: string): TaskItem[] {
  return new TaskStore(cwd, team).getAgentTasks(agentName);
}

export async function cleanupStaleTasks(
  cwd: string,
  team: string,
  maxAgeMs = 1_800_000,
  options?: { autoDelete?: boolean },
): Promise<number> {
  return new TaskStore(cwd, team).cleanupStaleTasks(maxAgeMs, options);
}

// ============================================================================
// P1: Re-export hook types for convenience
// ============================================================================

export {
  registerTaskCreatedHook,
  registerTaskCompletedHook,
  registerTaskTransitionHook,
  unregisterTaskCreatedHook,
  unregisterTaskCompletedHook,
  unregisterTaskTransitionHook,
  type HookResult,
  type HookContext,
  type TaskCreatedHook,
  type TaskCompletedHook,
  type TaskTransitionHook,
} from "./task-hooks.js";

// Types UpdateTaskOptions, CreateTaskOptions, FindCandidateAgentFn, IsAgentBusyFn,
// IsAgentAliveFn are already exported at definition site.
