/**
 * AIM — Agent Executor
 *
 * Core subagent execution engine. Encapsulates the full lifecycle of running
 * a subagent: worktree isolation, progress tracking, display state management,
 * transcript persistence, role-based tool filtering,
 * and task-system integration.
 *
 * Callers only need: await executeAgent(ctx, params) → AgentExecutionResult
 * All orchestration of the 6+ subsystems is handled internally.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Message } from "@mariozechner/pi-ai";

import { workerPool } from "./worker-pool.js";
import { discoverAgents } from "./agents.js";
import type { AgentConfig, AgentScope } from "./types.js";
import { collectUsageFromMessages, recordTokenUsage, recordTurn, recordStatusChange, persistProgress, recordError } from "./task-progress.js";
import { createWorktree, removeWorktreeByBase } from "./worktree.js";
import { getRoleTools, resolveRole } from "./permission-matrix.js";
import {
  writeAgentMetadata, readAgentMetadata, readTranscript,
  appendToTranscript,
  recordSubagentSpawn, recordSubagentResult,
} from "./aim-transcript.js";
import { updateTask, type TaskItem } from "./shared-tasks.js";
import { getActiveTeam } from "./teams.js";
import { getFinalOutput } from "./agent-result.js";
import { agentStarted, agentCompleted, agentFailed, agentResumed, agentBackgroundLaunched } from "./agent-lifecycle.js";

// ============================================================================
// Types
// ============================================================================

/** Execution context — parameters that stay constant across the call */
export interface ExecutionContext {
  pi: ExtensionAPI;
  cwd: string;
  agents: AgentConfig[];
  signal?: AbortSignal;
  onUpdate?: (update: AgentUpdate) => void;
}

/** Status update emitted during execution */
export interface AgentUpdate {
  agent: string;
  status: string;
  output: string;
}

/** Execution parameters — vary per invocation */
export interface AgentExecutionParams {
  agent: string;
  task: string;
  fork?: boolean;
  background?: boolean;
  cwd?: string;
  model?: string;
  tools?: string[];
  systemPrompt?: string;
  resumeAgentId?: string;
  taskId?: string;
  teamName?: string;
}

/** Token usage summary */
export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** Execution result — everything the caller needs, no post-processing required */
export interface AgentExecutionResult {
  /** Unique agent ID (for resume, transcript, task association) */
  agentId: string;
  /** Agent definition name */
  agentName: string;
  /** Agent source scope */
  agentSource: "user" | "project" | "unknown";
  /** Task description */
  task: string;
  /** Exit code: 0=success, >0=failure, -1=background launched (not yet complete) */
  exitCode: number;
  /** Final output text (pre-extracted, no need to call getFinalOutput) */
  output: string;
  /** Token usage (pre-aggregated, no need to call collectUsageFromMessages) */
  usage: UsageSummary;
  /** Raw messages (for rendering — extracting tool calls, expanded view, etc.) */
  messages: Message[];
  /** Model used */
  model?: string;
  /** Stop reason from the LLM */
  stopReason?: string;
  /** Error message if failed */
  errorMessage?: string;
  /** Whether this was a resume execution */
  resumed: boolean;
  /** Accumulated stderr */
  stderr: string;
}

// ============================================================================
// Constants
// ============================================================================

// CLEANUP_DELAY_MS and DEFAULT_AUTO_BACKGROUND_MS moved to agent-lifecycle.ts

// ============================================================================
// Core Function
// ============================================================================

/**
 * Execute a subagent.
 *
 * Internally manages the complete lifecycle:
 *   - Worktree creation/cleanup
 *   - Progress tracker creation/recording/persistence/cleanup
 *   - Display state creation/completion/cleanup
 *   - Transcript writing
 *   - Parent tree annotation (spawn/result)
 *   - Role-based tool filtering
 *   - Overflow detection and persistence
 *   - Task association (taskId → updateTask)
 *
 * Callers only need: const result = await executeAgent(ctx, params);
 */
export async function executeAgent(
  ctx: ExecutionContext,
  params: AgentExecutionParams,
): Promise<AgentExecutionResult> {
  const { pi, cwd, agents, signal, onUpdate } = ctx;

  // ═══ Resume path ═══
  if (params.resumeAgentId) {
    return executeResume(ctx, params, onUpdate);
  }

  // ═══ Validation ═══
  const agentDef = agents.find(a => a.name === params.agent);

  if (!agentDef) {
    const available = agents.map(a => `"${a.name}"`).join(", ") || "none";
    return buildErrorResult(params, `Unknown agent: "${params.agent}". Available: ${available}.`);
  }

  // ═══ Preparation ═══
  const agentId = generateAgentId();

  // Role-based tool filtering (infrastructure-level enforcement)
  const isTeammate = Boolean(params.teamName);
  const isCoordinator = (params.agent ?? "") === "coordinator" ||
    (params.systemPrompt?.toLowerCase() ?? "").includes("coordinator mode");
  const role = resolveRole({ isTeammate, isFork: params.fork ?? false, isCoordinator });
  const declaredTools = params.tools ?? agentDef.tools ?? [];
  const tools = getRoleTools(role, declaredTools);
  const model = params.model ?? agentDef.model;

  // Resolve system prompt
  const systemPrompt = agentDef.systemPrompt;

  // Persist metadata + annotate parent tree
  writeAgentMetadata(cwd, agentId, {
    agentType: agentDef.name,
    name: params.agent ?? "",
    task: params.task ?? "",
    model,
    tools: declaredTools,
    systemPrompt: agentDef.systemPrompt,
    forkMode: params.fork ?? false,
    background: params.background ?? false,
    createdAt: Date.now(),
  });

  recordSubagentSpawn(pi, {
    agentId,
    agent: params.agent,
    task: params.task,
    model,
    tools: declaredTools,
    background: params.background ?? false,
    forkMode: params.fork ?? false,
    transcriptFile: `.pi/aim/agents/${agentId}.jsonl`,
  });

  // ═══ Background path ═══
  if (params.background) {
    return executeBackground(ctx, agentId, params, agentDef, model, tools, systemPrompt, onUpdate);
  }

  // ═══ Foreground path ═══
  return executeForeground(ctx, agentId, params, agentDef, model, tools, systemPrompt, onUpdate);
}

// ============================================================================
// Resume Path
// ============================================================================

async function executeResume(
  ctx: ExecutionContext,
  params: AgentExecutionParams,
  onUpdate: ((update: AgentUpdate) => void) | undefined,
): Promise<AgentExecutionResult> {
  const { pi, cwd } = ctx;
  const agentId = params.resumeAgentId!;

  const meta = readAgentMetadata(cwd, agentId);
  if (!meta) {
    return buildErrorResult(params, `No metadata found for agent ${agentId}`, agentId);
  }

  const transcriptMsgs = readTranscript(cwd, agentId);
  if (transcriptMsgs.length === 0) {
    return buildErrorResult(params, `No transcript found for agent ${agentId}`, agentId);
  }

  const model = params.model ?? meta.model;
  const tools = params.tools ?? meta.tools;

  // Initialize lifecycle tracking BEFORE spawn so events from attachStdout are never lost.
  agentResumed(agentId, { foreground: !params.background });

  // Spawn worker in RPC mode for resume
  const workerId = workerPool.spawn({
    name: params.agent,
    prompt: params.task,
    model,
    tools,
    cwd: params.cwd ?? cwd,
    background: params.background ?? meta.background,
    forkFrom: undefined,
    systemPrompt: params.systemPrompt ?? meta.systemPrompt,
    rpcMode: true,
    agentId,
  });

  const info = workerPool.getInfo(workerId);
  if (!info) {
    agentFailed(agentId, cwd, "Worker spawn failed", null);
    return buildErrorResult(params, "Worker spawn failed", agentId);
  }

  onUpdate?.({ agent: params.agent, status: "running (resumed)", output: "" });

  // Background resume: return immediately (no display state needed).
  // Progress tracker is intentionally left active — the background worker
  // is still running and may emit events via attachStdout. Periodic cleanup
  // in extension-lifecycle.ts will remove it after 1 hour of inactivity.
  if (params.background) {
    return {
      agentId,
      agentName: params.agent,
      agentSource: meta.agentType as "user" | "project",
      task: params.task,
      exitCode: -1,
      output: "",
      usage: zeroUsage(),
      messages: [],
      model,
      resumed: true,
      stderr: "",
    };
  }

  // Foreground resume: display state was already created by agentResumed()

  try {
    // Use timeout to prevent infinite hangs
    const timeoutMs = DEFAULT_FOREGROUND_TIMEOUT_MS;
    const result = await workerPool.waitFor(workerId, timeoutMs).catch(err => {
      // Timeout or other error - kill the worker and return error
      console.warn(`[aim] Worker ${workerId} failed: ${err.message}`);
      workerPool.kill(workerId);
      return null;
    });
    
    if (!result) {
      return buildErrorResult(params, `Worker timed out after ${timeoutMs}ms`, agentId, true);
    }
    
    const usage = collectUsageFromMessages(result.messages);
    const output = getFinalOutput(result.messages);
    const lastAssistant = result.messages.filter(m => m.role === "assistant").pop() as Record<string, unknown> | undefined;
    const stopReason = lastAssistant?.stopReason as string | undefined;
    const errorMsg = lastAssistant?.errorMessage as string | undefined;

    appendToTranscript(cwd, agentId, result.messages);
    recordSubagentResult(pi, {
      agentId,
      status: result.exitCode === 0 ? "completed" : "failed",
      summary: output.slice(0, 200),
      usage,
      exitCode: result.exitCode ?? 1,
      model,
    });

    recordTokenUsage(agentId, { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
    recordTurn(agentId);
    recordStatusChange(agentId, result.exitCode === 0 ? "completed" : "failed");
    persistProgress(cwd, agentId);

    onUpdate?.({ agent: params.agent, status: result.exitCode === 0 ? "completed" : "error", output });

    return {
      agentId,
      agentName: params.agent,
      agentSource: meta.agentType as "user" | "project",
      task: params.task,
      exitCode: result.exitCode ?? 1,
      output,
      usage,
      messages: result.messages,
      model,
      stopReason,
      errorMessage: errorMsg,
      resumed: true,
      stderr: result.stderr,
    };
  } catch (err) {
    return buildErrorResult(params, err instanceof Error ? err.message : String(err), agentId, true);
  } finally {
    agentCompleted(cwd, agentId, null);
  }
}

// ============================================================================
// Background Path
// ============================================================================

async function executeBackground(
  ctx: ExecutionContext,
  agentId: string,
  params: AgentExecutionParams,
  agentDef: AgentConfig,
  model: string | undefined,
  tools: string[],
  systemPrompt: string | undefined,
  onUpdate: ((update: AgentUpdate) => void) | undefined,
): Promise<AgentExecutionResult> {
  const { pi, cwd } = ctx;

  // Initialize progress tracking BEFORE spawn so events from attachStdout are never lost.
  // No display state for background agents — they don't show in UI and would
  // leak (never markCompleted → never cleaned up by cleanupCompletedDisplayStates).
  // Progress tracker is intentionally left active — the background worker
  // is still running and may emit events via attachStdout. Periodic cleanup
  // in extension-lifecycle.ts will remove it after 1 hour of inactivity.
  agentBackgroundLaunched(agentId);

  const workerId = workerPool.spawn({
    name: params.agent,
    prompt: params.task,
    model,
    tools,
    cwd: params.cwd ?? cwd,
    background: true,
    systemPrompt,
    rpcMode: true,
    agentId,
  });

  const info = workerPool.getInfo(workerId);
  if (!info) {
    agentFailed(agentId, cwd, "Worker spawn failed", null);
    return buildErrorResult(params, "Worker spawn failed", agentId);
  }

  // Associate with task if needed
  if (params.taskId) {
    await associateWithTask(cwd, agentId, params.taskId, params.teamName);
  }

  onUpdate?.({ agent: params.agent, status: "running (background)", output: "" });

  return {
    agentId,
    agentName: params.agent ?? "",
    agentSource: agentDef.source,
    task: params.task,
    exitCode: -1,
    output: "",
    usage: zeroUsage(),
    messages: [],
    model,
    resumed: false,
    stderr: "",
  };
}

// ============================================================================
// Foreground Path
// ============================================================================

async function executeForeground(
  ctx: ExecutionContext,
  agentId: string,
  params: AgentExecutionParams,
  agentDef: AgentConfig,
  model: string | undefined,
  tools: string[],
  systemPrompt: string | undefined,
  onUpdate: ((update: AgentUpdate) => void) | undefined,
): Promise<AgentExecutionResult> {
  const { pi, cwd } = ctx;
  const useRpc = params.fork ?? false;

  // Create worktree for isolation
  const wt = createWorktree(cwd, agentId);
  const wtBaseDir: string | null = wt?.baseDir ?? null;
  const effectiveCwd = wt?.effectiveCwd ?? (params.cwd ?? cwd);

  // Initialize lifecycle tracking BEFORE spawn so events from attachStdout are never lost
  agentStarted(agentId, { foreground: true });

  const workerId = workerPool.spawn({
    name: params.agent,
    prompt: params.task,
    model,
    tools,
    cwd: effectiveCwd,
    background: false,
    systemPrompt,
    rpcMode: useRpc,
    agentId,
  });

  const info = workerPool.getInfo(workerId);
  if (!info) {
    agentFailed(agentId, cwd, "Worker spawn failed", wtBaseDir);
    return buildErrorResult(params, "Worker spawn failed", agentId);
  }

  onUpdate?.({ agent: params.agent, status: "running", output: "" });

  // Associate with task if needed
  if (params.taskId) {
    await associateWithTask(cwd, agentId, params.taskId, params.teamName);
  }

  try {
    // Use timeout to prevent infinite hangs
    const timeoutMs = DEFAULT_FOREGROUND_TIMEOUT_MS;
    const result = await workerPool.waitFor(workerId, timeoutMs).catch(err => {
      // Timeout or other error - kill the worker and return error
      console.warn(`[aim] Worker ${workerId} failed: ${err.message}`);
      workerPool.kill(workerId);
      return null;
    });
    
    if (!result) {
      return buildErrorResult(params, `Worker timed out after ${timeoutMs}ms`, agentId);
    }
    
    const usage = collectUsageFromMessages(result.messages);
    const output = getFinalOutput(result.messages);
    const lastAssistant = result.messages.filter(m => m.role === "assistant").pop() as Record<string, unknown> | undefined;
    const stopReason = lastAssistant?.stopReason as string | undefined;
    const errorMsg = lastAssistant?.errorMessage as string | undefined;

    // Persist transcript
    appendToTranscript(cwd, agentId, result.messages);
    recordSubagentResult(pi, {
      agentId,
      status: result.exitCode === 0 ? "completed" : "failed",
      summary: output.slice(0, 200),
      usage,
      exitCode: result.exitCode ?? 1,
      model,
    });

    // Update associated task
    if (params.taskId) {
      await completeTask(cwd, params.taskId, params.teamName, result.exitCode ?? 1, agentId);
    }

    // Record completion status
    recordStatusChange(agentId, result.exitCode === 0 ? "completed" : "failed");

    // Persist progress
    persistProgress(cwd, agentId);

    onUpdate?.({ agent: params.agent, status: result.exitCode === 0 ? "completed" : "error", output });

    return {
      agentId,
      agentName: params.agent ?? "",
      agentSource: agentDef.source,
      task: params.task,
      exitCode: result.exitCode ?? 1,
      output,
      usage,
      messages: result.messages,
      model,
      stopReason,
      errorMessage: errorMsg,
      resumed: false,
      stderr: result.stderr,
    };
  } catch (err) {
    return buildErrorResult(params, err instanceof Error ? err.message : String(err), agentId);
  } finally {
    agentCompleted(cwd, agentId, wtBaseDir);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function generateAgentId(): string {
  return `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function zeroUsage(): UsageSummary {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function buildErrorResult(
  params: AgentExecutionParams,
  error: string,
  agentId?: string,
  resumed = false,
): AgentExecutionResult {
  if (agentId) recordError(agentId, error);
  return {
    agentId: agentId ?? "",
    agentName: params.agent ?? "",
    agentSource: "unknown",
    task: params.task ?? "",
    exitCode: 1,
    output: "",
    usage: zeroUsage(),
    messages: [],
    stopReason: undefined,
    errorMessage: error,
    resumed,
    stderr: error,
  };
}

// cleanupAgent moved to agent-lifecycle.ts (agentCompleted/agentFailed)

/**
 * Associate an agent with a team task (set in_progress + metadata.agentId).
 */
async function associateWithTask(
  cwd: string,
  agentId: string,
  taskId: string,
  teamName?: string,
): Promise<void> {
  const activeTeam = teamName ? { name: teamName } : getActiveTeam();
  if (!activeTeam) return;
  try {
    await updateTask(cwd, activeTeam.name, taskId, {
      status: "in_progress",
      metadata: { agentId },
    });
  } catch (err) {
    console.warn(`[aim] Failed to associate agent ${agentId} with task #${taskId}:`, err);
  }
}

/**
 * Mark a team task as completed/failed after agent finishes.
 */
async function completeTask(
  cwd: string,
  taskId: string,
  teamName?: string,
  exitCode = 1,
  agentId?: string,
): Promise<void> {
  const activeTeam = teamName ? { name: teamName } : getActiveTeam();
  if (!activeTeam) return;
  try {
    const taskUpdate: Partial<Pick<TaskItem, "status" | "metadata">> = {
      status: exitCode === 0 ? "completed" : "failed",
      metadata: {
        agentId,
        exitCode,
        completedAt: Date.now(),
      },
    };
    await updateTask(cwd, activeTeam.name, taskId, taskUpdate);
  } catch (err) {
    console.warn(`[aim] Failed to update task #${taskId} after agent completion:`, err);
  }
}
