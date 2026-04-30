/**
 * AIM — Shared Task System (P2)
 *
 * File-based shared task list for team coordination.
 * Each team gets a task directory at .pi/aim/tasks/{team}/.
 *
 * Task lifecycle:
 *   pending → in_progress → completed / failed / blocked
 *
 * Thread-safe via file locking.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getTasksDir } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "failed";

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string | null;
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// Locking
// ============================================================================

async function lock(filePath: string): Promise<() => Promise<void>> {
  const lockPath = filePath + ".lock";
  const maxRetries = 30;
  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return async () => { try { fs.unlinkSync(lockPath); } catch {} };
    } catch {
      await new Promise(r => setTimeout(r, 50 + Math.random() * 50));
    }
  }
  throw new Error(`Could not acquire lock for ${filePath}`);
}

// ============================================================================
// I/O
// ============================================================================

function ensureDir(dir: string) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
  }
}

function taskFilePath(cwd: string, team: string, taskId: string): string {
  return path.join(getTasksDir(cwd, team), `task-${taskId}.json`);
}

/** Read all tasks for a team */
export function listTasks(cwd: string, team: string): Task[] {
  const dir = getTasksDir(cwd, team);
  if (!fs.existsSync(dir)) return [];
  const tasks: Task[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith("task-") || !f.endsWith(".json")) continue;
      try {
        tasks.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as Task);
      } catch {}
    }
  } catch {}
  return tasks.sort((a, b) => Number(a.id) - Number(b.id));
}

/** Create a task */
export async function createTask(cwd: string, team: string, subject: string, description = ""): Promise<Task> {
  const dir = getTasksDir(cwd, team);
  ensureDir(dir);
  const listFile = path.join(dir, ".list.lock");
  const release = await lock(listFile);
  try {
    const existing = listTasks(cwd, team);
    const nextId = String(existing.length > 0 ? Math.max(...existing.map(t => Number(t.id))) + 1 : 1);
    const task: Task = {
      id: nextId, subject, description, status: "pending",
      owner: null, blockedBy: [], createdAt: Date.now(), updatedAt: Date.now(),
    };
    fs.writeFileSync(taskFilePath(cwd, team, nextId), JSON.stringify(task, null, 2));
    return task;
  } finally {
    await release();
  }
}

/** Update a task */
export async function updateTask(cwd: string, team: string, taskId: string, updates: Partial<Pick<Task, "status" | "owner" | "blockedBy">>): Promise<Task | null> {
  const fp = taskFilePath(cwd, team, taskId);
  if (!fs.existsSync(fp)) return null;
  const release = await lock(fp);
  try {
    const task = JSON.parse(fs.readFileSync(fp, "utf-8")) as Task;
    if (updates.status) task.status = updates.status;
    if (updates.owner !== undefined) task.owner = updates.owner;
    if (updates.blockedBy) task.blockedBy = updates.blockedBy;
    task.updatedAt = Date.now();
    fs.writeFileSync(fp, JSON.stringify(task, null, 2));
    return task;
  } finally {
    await release();
  }
}

/** Claim a pending task (sets to in_progress with owner) */
export async function claimTask(cwd: string, team: string, taskId: string, owner: string): Promise<Task | null> {
  const fp = taskFilePath(cwd, team, taskId);
  if (!fs.existsSync(fp)) return null;
  const release = await lock(fp);
  try {
    const task = JSON.parse(fs.readFileSync(fp, "utf-8")) as Task;
    if (task.status !== "pending") return null;
    // Check blockedBy: all blocked tasks must be completed
    const allTasks = listTasks(cwd, team);
    for (const bid of task.blockedBy) {
      const blocker = allTasks.find(t => t.id === bid);
      if (blocker && blocker.status !== "completed") return null;
    }
    task.status = "in_progress";
    task.owner = owner;
    task.updatedAt = Date.now();
    fs.writeFileSync(fp, JSON.stringify(task, null, 2));
    return task;
  } finally {
    await release();
  }
}

/** Find the next available (pending, unblocked, unowned) task */
export function findAvailableTask(cwd: string, team: string): Task | null {
  const all = listTasks(cwd, team);
  const blockedSet = new Set(all.filter(t => t.status !== "completed").map(t => t.id));
  return all.find(t =>
    t.status === "pending" &&
    !t.owner &&
    t.blockedBy.every(bid => !blockedSet.has(bid))
  ) ?? null;
}