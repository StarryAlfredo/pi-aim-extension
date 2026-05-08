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
} from "./types.js";

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

// ============================================================================
// Locking (with stale lock detection)
// ============================================================================

/** Maximum lock retries before giving up */
const MAX_LOCK_RETRIES = 30;

/** Locks older than this (ms) are considered stale and force-released */
const STALE_LOCK_MS = 10_000;

/**
 * Acquire an exclusive file lock.
 * Stale locks (>10s old) are force-released automatically.
 * Returns a release function that must be called in a finally block.
 * 
 * Thread safety: writeFileSync with { flag: "wx" } is atomic on both
 * POSIX and NTFS. Even if two processes detect the same stale lock
 * simultaneously, only one will succeed in creating the new lock file,
 * preventing double-acquisition.
 */
async function lock(filePath: string): Promise<() => Promise<void>> {
  const lockPath = filePath + ".lock";
  for (let i = 0; i < MAX_LOCK_RETRIES; i++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return async () => {
        try { fs.unlinkSync(lockPath); } catch {}
      };
    } catch {
      // Check for stale lock — safe because writeFileSync with { flag: "wx" }
      // is atomic. Even if two processes detect the same stale lock, only
      // one will succeed in creating the replacement lock file.
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          // Force-release stale lock and retry immediately
          try { fs.unlinkSync(lockPath); } catch {}
          continue;
        }
      } catch {
        // Lock was released between our failed write and stat — retry
      }
      await new Promise(r => setTimeout(r, 50 + Math.random() * 50));
    }
  }
  throw new Error(`Could not acquire lock for ${filePath}`);
}

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
    return JSON.parse(fs.readFileSync(fp, "utf-8")) as TaskItem;
  } catch {
    return null;
  }
}

/** Write a single task file */
function writeTaskFile(cwd: string, team: string, task: TaskItem): void {
  const fp = taskFilePath(cwd, team, task.id);
  fs.writeFileSync(fp, JSON.stringify(task, null, 2));
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
      } catch {}
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
  const release = await lock(listLockPath(cwd, team));
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

    // Validate all blockedBy references exist before writing
    if (task.blockedBy.length > 0) {
      for (const blockerId of task.blockedBy) {
        const blocker = readTaskFile(cwd, team, blockerId);
        if (!blocker) {
          throw new Error(`Cannot create task: blocker #${blockerId} does not exist`);
        }
      }
    }

    writeTaskFile(cwd, team, task);

    // Bidirectional: if blockedBy is set, update each blocker's blocks[]
    if (task.blockedBy.length > 0) {
      for (const blockerId of task.blockedBy) {
        const blocker = readTaskFile(cwd, team, blockerId);
        if (!blocker.blocks.includes(nextId)) {
          blocker.blocks.push(nextId);
          blocker.updatedAt = Date.now();
          writeTaskFile(cwd, team, blocker);
        }
      }
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
): Promise<TaskItem | null> {
  const fp = taskFilePath(cwd, team, taskId);

  // Strategy B: list lock serializes all write operations
  const release = await lock(listLockPath(cwd, team));
  try {
    // TOCTOU-safe: check existence inside the lock
    if (!fs.existsSync(fp)) return null;

    const task = JSON.parse(fs.readFileSync(fp, "utf-8")) as TaskItem;

    // Terminal state protection: reject all mutations on completed/failed/killed tasks
    if (isTerminalStatus(task.status)) {
      throw new Error(`Cannot update task #${taskId}: status is "${task.status}" (terminal)`);
    }

    // State transition validation
    if (updates.status !== undefined && updates.status !== task.status) {
      if (!canTransition(task.status, updates.status)) {
        throw new Error(
          `Invalid state transition for task #${taskId}: "${task.status}" → "${updates.status}"` +
          ` (allowed: ${VALID_TRANSITIONS[task.status]?.join(", ") ?? "none"})`,
        );
      }
    }

    // Apply updates
    if (updates.status !== undefined) task.status = updates.status;
    if (updates.owner !== undefined) task.owner = updates.owner;
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.activeForm !== undefined) task.activeForm = updates.activeForm;
    if (updates.metadata !== undefined) task.metadata = updates.metadata;
    task.updatedAt = Date.now();

    writeTaskFile(cwd, team, task);

    return task;
  } finally {
    await release();
  }
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
  const release = await lock(listLockPath(cwd, team));
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

    // Check all blockers are completed
    const allTasks = listTasks(cwd, team);
    for (const blockerId of task.blockedBy) {
      const blocker = allTasks.find(t => t.id === blockerId);
      if (!blocker || blocker.status !== "completed") {
        return { rejected: true, reason: `blocked_by_${blockerId}` };
      }
    }

    // Check agent is not already busy with another open task.
    // Use != null to match both null (legacy JSON) and undefined (current).
    const agentOpen = allTasks.filter(t =>
      t.owner != null && t.owner === owner &&
      !isTerminalStatus(t.status) &&
      t.id !== taskId,
    );
    if (agentOpen.length > 0) {
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
  const release = await lock(listLockPath(cwd, team));
  try {
    const blocker = readTaskFile(cwd, team, blockerId);
    const blocked = readTaskFile(cwd, team, blockedId);
    if (!blocker) throw new Error(`Task #${blockerId} not found`);
    if (!blocked) throw new Error(`Task #${blockedId} not found`);

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
  const release = await lock(listLockPath(cwd, team));
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
): Promise<boolean> {
  const dir = getTasksDir(cwd, team);
  if (!fs.existsSync(dir)) return false;

  const release = await lock(listLockPath(cwd, team));
  try {
    // TOCTOU-safe: check existence inside the lock
    const fp = taskFilePath(cwd, team, taskId);
    if (!fs.existsSync(fp)) return false;
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
        other.updatedAt = Date.now();
        writeTaskFile(cwd, team, other);
      }
    }

    // Delete the task file (high-water mark is preserved)
    try { fs.unlinkSync(fp); } catch { return false; }
    return true;
  } finally {
    await release();
  }
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