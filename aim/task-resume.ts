/**
 * AIM — Task Resume System (P6)
 *
 * Supports resuming interrupted tasks after crashes or session restarts.
 * Mirrors Claude Code's resumeAgent mechanism:
 *
 *   - Scans for in_progress tasks whose owner has gone offline
 *   - Re-spawns the subagent with the existing transcript as context
 *   - Updates task status on resume success or failure
 *   - Provides a tool for manual resume of specific tasks
 *
 * Integration points:
 *   - index.ts: registers the task_resume tool
 *   - shared-tasks.ts: cleanupStaleTasks() can use resume as alternative to killing
 *   - worker-pool.ts: spawn with resume context from transcript
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { getTask, updateTask, forceTaskStatus, listTasks, isTerminalStatus } from "./shared-tasks.js";
import { getActiveTeam } from "./teams.js";
import { readAgentMetadata, readTranscript } from "./aim-transcript.js";
import { getProgressTracker, createProgressTracker, loadProgress, persistProgress, generateCompactSummary, removeProgressTracker } from "./task-progress.js";
import { createDisplayState, markCompleted, removeDisplayState } from "./task-foreground.js";
import { workerPool } from "./worker-pool.js";
import { createWorktree, removeWorktreeByBase } from "./worktree.js";
import { recordSubagentSpawn, recordSubagentResult, appendToTranscript } from "./aim-transcript.js";
import { getFinalOutput } from "./render.js";
import { discoverAgents } from "./agents.js";
import type { TaskItem, WorkerInfo } from "./types.js";
import type { Message } from "@mariozechner/pi-ai";

// ============================================================================
// Resume Logic
// ============================================================================

export interface ResumeResult {
  success: boolean;
  task?: TaskItem;
  agentId?: string;
  error?: string;
}

/**
 * Resume an interrupted task by re-spawning its agent with existing transcript context.
 *
 * This is the core resume mechanism:
 *   1. Read the task and its agent metadata
 *   2. Load the existing transcript for context
 *   3. Re-spawn the agent with --session pointing to the transcript
 *   4. Track the new agent as the task's owner
 *
 * @param cwd Working directory
 * @param team Team name
 * @param taskId Task ID to resume
 * @param options Resume options
 */
export async function resumeTask(
  cwd: string,
  team: string,
  taskId: string,
  options?: {
    /** Override the prompt for the resumed agent */
    prompt?: string;
    /** Model override */
    model?: string;
    /** Abort signal */
    signal?: AbortSignal;
    /** Progress callback */
    onUpdate?: (partial: { status: string; output: string }) => void;
  },
): Promise<ResumeResult> {
  const task = getTask(cwd, team, taskId);
  if (!task) {
    return { success: false, error: `Task #${taskId} not found` };
  }

  if (task.status !== "in_progress") {
    return { success: false, error: `Task #${taskId} is "${task.status}" (must be in_progress to resume)` };
  }

  // Find the agent ID associated with this task.
  // The owner field stores the agent name, but the actual agentId (used for
  // transcript files) may differ. Check metadata first, then fall back to owner.
  const agentId = (task.metadata?.agentId as string) ?? task.owner;
  if (!agentId) {
    return { success: false, error: `Task #${taskId} has no associated agent ID` };
  }

  // Load agent metadata for context
  const meta = readAgentMetadata(cwd, agentId);
  const transcriptMsgs = meta ? readTranscript(cwd, agentId) : [];

  // Load persisted progress if available
  const savedProgress = loadProgress(cwd, agentId, team);

  // Build the resume prompt
  const resumePrompt = options?.prompt ?? [
    `Resume task #${taskId}: ${task.subject}`,
    task.description ? `\n${task.description}` : "",
    transcriptMsgs.length > 0
      ? `\n\nYou are continuing a previously interrupted task. The conversation history has been loaded. Continue from where you left off.`
      : "",
  ].join("");

  // Re-spawn the agent with RPC mode (resumable)
  const model = options?.model ?? meta?.model;
  const tools = meta?.tools;

  // Create worktree for isolation
  const wt = createWorktree(cwd, agentId);
  const wtBaseDir: string | null = wt?.baseDir ?? null;
  const effectiveCwd = wt?.effectiveCwd ?? cwd;

  const workerId = workerPool.spawn({
    name: task.owner ?? "resumed-agent",
    prompt: resumePrompt,
    model,
    tools,
    cwd: effectiveCwd,
    rpcMode: true,
    agentId, // Reuse the same agentId for transcript continuity
    background: false,
  });

  const info = workerPool.getInfo(workerId);
  if (!info) {
    if (wtBaseDir) removeWorktreeByBase(cwd, wtBaseDir);
    return { success: false, error: "Failed to spawn worker for resume" };
  }

  // Create progress tracker for the resumed task
  const progress = createProgressTracker(agentId);
  if (savedProgress) {
    // Restore token counts from saved progress
    progress.tokenUsage = { ...savedProgress.tokenUsage };
    progress.turnCount = savedProgress.turnCount;
  }

  // Create display state
  const displayState = createDisplayState(agentId, {
    isForeground: true,
    autoBackgroundAfterMs: 60_000,
    retain: false,
  });

  options?.onUpdate?.({ status: "running (resumed)", output: "" });

  // Update task metadata to track the resume
  try {
    await updateTask(cwd, team, taskId, {
      metadata: {
        ...task.metadata,
        resumedAt: Date.now(),
        resumeCount: ((task.metadata?.resumeCount as number) ?? 0) + 1,
      },
    });
  } catch {
    // Non-fatal: metadata update failure shouldn't block resume
  }

  // Wait for the agent to fully exit (close event), not just the first agent_end.
  // In RPC mode, agent_end only means "one turn complete" — the worker stays alive
  // waiting for more commands. We need to wait for the process to actually exit
  // to correctly capture the final result.
  try {
    const CLOSE_TIMEOUT_MS = 600_000; // 10 minutes
    const closeResult = await new Promise<WorkerInfo>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Resume timed out after ${CLOSE_TIMEOUT_MS / 1000}s`));
      }, CLOSE_TIMEOUT_MS);

      // Poll for worker death (close event sets state to "dead")
      const check = setInterval(() => {
        const info = workerPool.getInfo(workerId);
        if (!info || info.state === "dead") {
          clearInterval(check);
          clearTimeout(timeout);
          resolve(info!);
        }
      }, 500);
    });

    const result = closeResult;
    const usage = collectUsageFromMessages(result.messages);
    const finalOutput = getFinalOutput(result.messages);

    // Append to existing transcript
    appendToTranscript(cwd, agentId, result.messages);

    // Persist progress
    persistProgress(cwd, agentId, team);

    // Mark display as completed
    markCompleted(agentId);

    // Clean up
    setTimeout(() => {
      removeProgressTracker(agentId);
      removeDisplayState(agentId);
    }, 5000);

    if (wtBaseDir) removeWorktreeByBase(cwd, wtBaseDir);

    options?.onUpdate?.({ status: result.exitCode === 0 ? "completed" : "error", output: finalOutput });

    return {
      success: true,
      task: getTask(cwd, team, taskId) ?? task,
      agentId,
    };
  } catch (err) {
    if (wtBaseDir) removeWorktreeByBase(cwd, wtBaseDir);
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Resume failed: ${message}`, agentId };
  }
}

// ============================================================================
// Orphan Detection
// ============================================================================

export interface OrphanTask {
  task: TaskItem;
  /** How long the task has been in_progress (ms) */
  ageMs: number;
  /** Whether the agent has persisted progress data */
  hasProgressData: boolean;
}

/**
 * Find orphaned tasks: in_progress tasks whose agents are no longer running.
 *
 * An orphan is detected by:
 *   1. Task has been in_progress for longer than maxAgeMs
 *   2. The agent's worker is not in the worker pool
 *   3. The agent has no recent progress updates
 *
 * @param cwd Working directory
 * @param team Team name
 * @param maxAgeMs Maximum age before considering orphaned (default: 30 min)
 */
export function findOrphanTasks(
  cwd: string,
  team: string,
  maxAgeMs = 1_800_000,
): OrphanTask[] {
  const now = Date.now();
  const tasks = listTasks(cwd, team);
  const orphans: OrphanTask[] = [];

  for (const task of tasks) {
    if (task.status !== "in_progress") continue;
    const age = now - task.updatedAt;
    if (age <= maxAgeMs) continue;

    // Check if the agent is still in the worker pool
    const agentId = (task.metadata?.agentId as string) ?? task.owner;
    if (agentId) {
      const workerInfo = workerPool.getInfo(agentId);
      if (workerInfo && workerInfo.state !== "dead") {
        // Agent is still running — not an orphan
        continue;
      }
    }

    // Check for recent progress activity
    const progress = getProgressTracker(agentId ?? task.id);
    const hasRecentActivity = progress && (now - progress.lastActivityAt) < maxAgeMs;

    orphans.push({
      task,
      ageMs: age,
      hasProgressData: progress !== null || loadProgress(cwd, agentId ?? task.id, team) !== null,
    });
  }

  return orphans;
}

/**
 * Attempt to resume all orphaned tasks, or kill them if resume fails.
 *
 * @param cwd Working directory
 * @param team Team name
 * @param options Resume/kill options
 * @returns Summary of actions taken
 */
export async function recoverOrphanTasks(
  cwd: string,
  team: string,
  options?: {
    /** Maximum age before considering orphaned (default: 30 min) */
    maxAgeMs?: number;
    /** Whether to kill orphans that can't be resumed (default: true) */
    killUnresumable?: boolean;
    /** Signal for abort */
    signal?: AbortSignal;
  },
): Promise<{
  resumed: number;
  killed: number;
  failed: number;
  details: { taskId: string; action: "resumed" | "killed" | "failed"; error?: string }[];
}> {
  const orphans = findOrphanTasks(cwd, team, options?.maxAgeMs);
  const result = {
    resumed: 0,
    killed: 0,
    failed: 0,
    details: [] as { taskId: string; action: "resumed" | "killed" | "failed"; error?: string }[],
  };

  for (const orphan of orphans) {
    if (options?.signal?.aborted) break;

    // Only try to resume if there's progress data (meaning the agent actually started)
    if (orphan.hasProgressData) {
      try {
        const resumeResult = await resumeTask(cwd, team, orphan.task.id, {
          signal: options?.signal,
        });

        if (resumeResult.success) {
          result.resumed++;
          result.details.push({ taskId: orphan.task.id, action: "resumed" });
        } else if (options?.killUnresumable !== false) {
          // Resume failed — kill the orphan
          await forceTaskStatus(cwd, team, orphan.task.id, "killed", `Orphan recovery failed: ${resumeResult.error}`);
          result.killed++;
          result.details.push({ taskId: orphan.task.id, action: "killed", error: resumeResult.error });
        } else {
          result.failed++;
          result.details.push({ taskId: orphan.task.id, action: "failed", error: resumeResult.error });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (options?.killUnresumable !== false) {
          try {
            await forceTaskStatus(cwd, team, orphan.task.id, "killed", `Orphan recovery error: ${msg}`);
            result.killed++;
            result.details.push({ taskId: orphan.task.id, action: "killed", error: msg });
          } catch {
            result.failed++;
            result.details.push({ taskId: orphan.task.id, action: "failed", error: msg });
          }
        } else {
          result.failed++;
          result.details.push({ taskId: orphan.task.id, action: "failed", error: msg });
        }
      }
    } else if (options?.killUnresumable !== false) {
      // No progress data — agent never started, just kill
      try {
        await forceTaskStatus(cwd, team, orphan.task.id, "killed", "Orphan with no progress data");
        result.killed++;
        result.details.push({ taskId: orphan.task.id, action: "killed" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.failed++;
        result.details.push({ taskId: orphan.task.id, action: "failed", error: msg });
      }
    }
  }

  return result;
}

// ============================================================================
// Helper
// ============================================================================

function collectUsageFromMessages(messages: Message[]): {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cost: number; contextTokens: number; turns: number;
} {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, turns = 0;
  for (const msg of messages) {
    if (msg.role === "assistant") {
      turns++;
      const usage = (msg as Record<string, unknown>).usage as Record<string, number> | undefined;
      if (usage) {
        input += usage.input || 0;
        output += usage.output || 0;
        cacheRead += usage.cacheRead || 0;
        cacheWrite += usage.cacheWrite || 0;
      }
    }
  }
  return { input, output, cacheRead, cacheWrite, cost: 0, contextTokens: 0, turns };
}
