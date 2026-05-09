/**
 * AIM - Multi-Agent Orchestration
 *
 * Core extension providing multi-agent capabilities to pi coding agent.
 * Gives LLM the ability to spawn, coordinate, and communicate with child agents.
 *
 * ## Subagent Execution Modes
 *
 *   Print mode (one-shot):  pi --mode json -p "task"
 *     Worker runs the prompt and exits. Fast, simple, no resume.
 *
 *   RPC mode (long-lived):  pi --mode rpc
 *     Worker stays alive, can receive steering/follow-up/abort commands.
 *     Used for: fork (inherit context), background agents that can be resumed.
 *
 * ## Transcript Persistence
 *
 *   Subagent conversations are stored as sidechain JSONL files:
 *     .pi/aim/agents/{agentId}.jsonl
 *     .pi/aim/agents/{agentId}.meta.json
 *
 *   The parent session tree is annotated with custom entries:
 *     custom { type: "aim-subagent-spawn", data: {...} }
 *     custom { type: "aim-subagent-result", data: {...} }
 *
 * This keeps the parent tree clean while preserving full subagent history
 * for resume and debugging.
 *
 * ## Fork Mode
 *
 *   fork: true copies the parent session's current messages into a new
 *   subagent session via --session. The subagent inherits the full
 *   conversation context, sharing the prompt cache with the parent.
 *   The subagent transcript is still stored in a sidechain file.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Container, Text, Markdown, Spacer } from "@mariozechner/pi-tui";

import { workerPool } from "./worker-pool.js";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";

import { discoverAgents, type AgentConfig, type AgentScope } from "./agents.js";
import { registerSendMessage } from "./send-message.js";
import { registerCoordinator } from "./coordinator.js";
import { createWorktree, removeWorktreeByBase } from "./worktree.js";
import { registerTeams } from "./teams.js";
import { registerPermissions } from "./permissions.js";
import { registerSwarm } from "./swarm.js";
// P5: Task tools
import { registerTaskCreateTool } from "./task-create-tool.js";
import { registerTaskUpdateTool } from "./task-update-tool.js";
import { registerTaskOutputTool } from "./task-output-tool.js";
import { registerTaskListTool } from "./task-list-tool.js";
// P6: Task resume
import { resumeTask, findOrphanTasks, recoverOrphanTasks, type ResumeResult, type OrphanTask } from "./task-resume.js";
import { getDisplayItems, getFinalOutput, formatToolCall, formatUsageStats, renderSubagentResult } from "./render.js";
import {
  writeAgentMetadata, readAgentMetadata, readTranscript, appendToTranscript,
  recordSubagentSpawn, recordSubagentResult,
} from "./aim-transcript.js";
import {
  listTasks, createTask, updateTask, claimTask, findAvailableTask,
  deleteTask, blockTask, unblockTask, findUnblockedTasks, isAgentBusy, getAgentTasks, getTask,
  cleanupStaleTasks,
  isTerminalStatus, canTransition, VALID_TRANSITIONS,
  type TaskItem, type TaskStatus, type TaskType, type CreateTaskOptions,
  // P1: Hook system re-exports
  registerTaskCreatedHook, registerTaskCompletedHook, registerTaskTransitionHook,
  type HookResult, type HookContext, type TaskCreatedHook, type TaskCompletedHook, type TaskTransitionHook,
  // P0/P1: Infrastructure types
  registerFindCandidateAgent, forceTaskStatus,
  registerIsAgentBusy,
  type UpdateTaskOptions, type FindCandidateAgentFn, type IsAgentBusyFn,
} from "./shared-tasks.js";

import {
  isAgentBusyStatus, getAgentStatus, getTeamAgentStatuses, getTeamStatusSnapshot,
  findLeastBusyAgent, getAgentOpenTasks, formatAgentStatuses,
  type AgentStatus, type AgentBusyState, type TeamAgentStatusSnapshot,
} from "./agent-status.js";

// Re-export for other extensions
export { workerPool } from "./worker-pool.js";
export { readMailbox, writeToMailbox, markMessageAsRead, isShutdownRequest, isPermissionResponse, createShutdownRequest, createShutdownApproval, createShutdownRejection, createIdleNotification } from "./mailbox.js";
export { discoverAgents, formatAgentList } from "./agents.js";
export { createTeam, deleteTeam, spawnTeammate, getActiveTeam } from "./teams.js";
export { pollInbox, sendIdleNotification } from "./poller.js";
import { notifyTaskAssignment, notifyTaskUnblocked, notifyTaskCompleted, nudgeVerification, registerMarkNudgeSent, type TaskNotification } from "./task-notifications.js";
import { startLeadPoller, type LeadPollerConfig, type PermissionRequestHandler } from "./lead-poller.js";
import { handleIdleAgent, distributeAvailableTasks, handleTaskCompleted, type DistributionResult } from "./task-distributor.js";
import { requestPermissionViaMailbox, isTeammateProcess, needsMailboxPermission, type PermissionResult } from "./permission-sync.js";
// P7: Result overflow protection
import {
  handleResultOverflow, handleBatchOverflow,
  readPersistedResult, isResultPersisted, getPersistedResultPath,
  formatOverflowDisplay, formatBatchOverflowDisplay,
  cleanupResultFiles,
  PER_AGENT_INLINE_LIMIT, PER_AGENT_PREVIEW_BYTES, PER_MESSAGE_BUDGET,
  type OverflowResult, type BatchOverflowResult,
} from "./task-result-storage.js";
// P8: Task rendering
import {
  renderTaskList, renderTaskListText, renderTaskDetail,
  renderAgentStatuses, renderAgentStatusesText,
  renderTaskEvent, renderTaskEventText,
  renderProgressInline, renderProgressDetail,
  renderDashboard, renderDashboardText,
  renderTaskBadge,
} from "./task-render.js";
// P3: Progress tracking
import {
  recordStatusChange,
  removeProgressTracker,
  persistProgress, deletePersistedProgress,
  getProgressTracker, generateCompactSummary,
} from "./task-progress.js";
// P4: Foreground/background management
import {
  createDisplayState, backgroundTask, foregroundTask, backgroundAll,
  markCompleted, evictTask, resetAutoBackgroundTimer,
  removeDisplayState, clearAllDisplayStates, cleanupCompletedDisplayStates,
  getDisplayState, isForeground as isTaskForeground,
  getForegroundTasks, getBackgroundTasks, hasForegroundTasks,
  formatDisplayStateSummary, formatBackgroundTaskList,
  onTransition as onDisplayTransition, onEvict,
  type TaskDisplayState, type TransitionResult,
} from "./task-foreground.js";
export { notifyTaskAssignment, notifyTaskUnblocked, notifyTaskCompleted, nudgeVerification, registerMarkNudgeSent, type TaskNotification } from "./task-notifications.js";
export { startLeadPoller, type LeadPollerConfig, type PermissionRequestHandler } from "./lead-poller.js";
export { handleIdleAgent, distributeAvailableTasks, handleTaskCompleted, type DistributionResult } from "./task-distributor.js";
export { requestPermissionViaMailbox, isTeammateProcess, needsMailboxPermission, type PermissionResult } from "./permission-sync.js";
// P5: Task tools re-exports
export { registerTaskCreateTool } from "./task-create-tool.js";
export { registerTaskUpdateTool } from "./task-update-tool.js";
export { registerTaskOutputTool } from "./task-output-tool.js";
export { registerTaskListTool } from "./task-list-tool.js";
// P6: Task resume re-exports
export { resumeTask, findOrphanTasks, recoverOrphanTasks, type ResumeResult, type OrphanTask } from "./task-resume.js";
// P3: Progress tracking re-exports
export {
  createProgressTracker, recordToolUse, recordTokenUsage, recordTurn,
  recordStatusChange, recordError, removeProgressTracker,
  persistProgress, deletePersistedProgress, loadProgress,
  getProgressTracker, generateProgressSummary, generateCompactSummary,
  formatTokenUsage, formatTokenCount,
  type TaskProgress, type TokenUsage, type ActivityEntry,
} from "./task-progress.js";
// P4: Foreground/background re-exports
export {
  createDisplayState, backgroundTask, foregroundTask, backgroundAll,
  markCompleted, evictTask, resetAutoBackgroundTimer,
  removeDisplayState, clearAllDisplayStates, cleanupCompletedDisplayStates,
  getDisplayState, isForeground as isTaskForeground,
  getForegroundTasks, getBackgroundTasks, hasForegroundTasks,
  formatDisplayStateSummary, formatBackgroundTaskList,
  type TaskDisplayState, type TransitionResult,
} from "./task-foreground.js";
export { writeAgentMetadata, readAgentMetadata, appendToTranscript, readTranscript, recordSubagentSpawn, recordSubagentResult } from "./aim-transcript.js";
export { 
  listTasks, createTask, updateTask, claimTask, findAvailableTask,
  deleteTask, blockTask, unblockTask, findUnblockedTasks, isAgentBusy, getAgentTasks, getTask,
  cleanupStaleTasks,
  isTerminalStatus, canTransition, VALID_TRANSITIONS,
  type TaskItem, type TaskStatus, type TaskType, type CreateTaskOptions,
  // P1: Hook system
  registerTaskCreatedHook, registerTaskCompletedHook, registerTaskTransitionHook,
  type HookResult, type HookContext, type TaskCreatedHook, type TaskCompletedHook, type TaskTransitionHook,
  // P0/P1: Infrastructure
  registerFindCandidateAgent, forceTaskStatus,
  registerIsAgentBusy,
  type UpdateTaskOptions, type FindCandidateAgentFn, type IsAgentBusyFn,
} from "./shared-tasks.js";

export {
  isAgentBusyStatus, getAgentStatus, getTeamAgentStatuses, getTeamStatusSnapshot,
  findLeastBusyAgent, getAgentOpenTasks, formatAgentStatuses,
  type AgentStatus, type AgentBusyState, type TeamAgentStatusSnapshot,
} from "./agent-status.js";
// P7: Result storage re-exports
export {
  handleResultOverflow, handleBatchOverflow,
  readPersistedResult, isResultPersisted, getPersistedResultPath,
  formatOverflowDisplay, formatBatchOverflowDisplay,
  cleanupResultFiles,
  PER_AGENT_INLINE_LIMIT, PER_AGENT_PREVIEW_BYTES, PER_MESSAGE_BUDGET,
  type OverflowResult, type BatchOverflowResult,
} from "./task-result-storage.js";
// P8: Task render re-exports
export {
  renderTaskList, renderTaskListText, renderTaskDetail,
  renderAgentStatuses, renderAgentStatusesText,
  renderTaskEvent, renderTaskEventText,
  renderProgressInline, renderProgressDetail,
  renderDashboard, renderDashboardText,
  renderTaskBadge,
} from "./task-render.js";
export { parseStructuredMessage, createPlanApprovalRequest, createPlanApprovalResponse } from "./mailbox.js";
export type { WorkerConfig, WorkerInfo, AgentConfig, AgentScope, AgentDiscoveryResult, TeammateMessage, TeamFile, TeamMember, SubagentSpawnData, SubagentResultData } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

// ============================================================================
// Helpers
// ============================================================================

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[], concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

// ============================================================================
// Usage Collection
// ============================================================================

function collectUsage(messages: Message[]): SingleResult["usage"] {
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

// ============================================================================
// Subagent result type
// ============================================================================

interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens: number; turns: number };
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  agentId?: string;
  resumed?: boolean;
}

// ============================================================================
// Subagent Execution
// ============================================================================

async function runSingleAgent(
  pi: ExtensionAPI,
  cwd: string,
  agents: AgentConfig[],
  params: {
    agent: string; task: string; fork?: boolean; background?: boolean;
    cwd?: string; model?: string; tools?: string[]; systemPrompt?: string;
    resumeAgentId?: string;
    task_id?: string; // P6: associate with a task
  },
  signal: AbortSignal | undefined,
  onUpdate: ((partial: { agent: string; status: string; output: string }) => void) | undefined,
): Promise<SingleResult> {
  const agentDef = agents.find((a) => a.name === params.agent);

  // --- Resume path ---
  if (params.resumeAgentId) {
    const meta = readAgentMetadata(cwd, params.resumeAgentId);
    if (!meta) throw new Error(`No metadata found for agent ${params.resumeAgentId}`);
    const transcriptMsgs = readTranscript(cwd, params.resumeAgentId);
    if (transcriptMsgs.length === 0) throw new Error(`No transcript found for agent ${params.resumeAgentId}`);

    // Build combined dispatch: RPC mode, pass --session to load existing transcript
    const workerId = workerPool.spawn({
      name: params.agent, prompt: params.task,
      model: params.model ?? meta.model,
      tools: params.tools ?? meta.tools,
      cwd: params.cwd ?? cwd,
      background: params.background ?? meta.background,
      forkFrom: undefined, // resume loads transcript from sidechain file via readTranscript
      systemPrompt: params.systemPrompt,
      rpcMode: true,
      agentId: params.resumeAgentId,
    });

    const info = workerPool.getInfo(workerId);
    if (!info) throw new Error("Worker spawn failed");

    onUpdate?.({ agent: params.agent, status: "running (resumed)", output: "" });

    if (params.background) {
      return {
        agent: params.agent, agentSource: meta.agentType as "user" | "project", task: params.task,
        exitCode: -1, messages: [], stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        agentId: params.resumeAgentId, resumed: true,
      };
    }

    try {
      const result = await workerPool.waitFor(workerId);
      const usage = collectUsage(result.messages);
      const finalOutput = getFinalOutput(result.messages);
      const lastAssistant = result.messages.filter(m => m.role === "assistant").pop() as Record<string, unknown> | undefined;
      const stopReason = lastAssistant?.stopReason as string | undefined;
      const errorMsg = lastAssistant?.errorMessage as string | undefined;

      // Append to transcript
      appendToTranscript(cwd, params.resumeAgentId, result.messages);

      // Record result in parent tree
      recordSubagentResult(pi, {
        agentId: params.resumeAgentId,
        status: result.exitCode === 0 ? "completed" : "failed",
        summary: finalOutput.slice(0, 200),
        usage, exitCode: result.exitCode ?? 1,
        model: result.messages.find(m => m.role === "assistant") && (result.messages.find(m => m.role === "assistant") as Record<string, unknown>).model as string | undefined,
      });

      onUpdate?.({ agent: params.agent, status: result.exitCode === 0 ? "completed" : "error", output: finalOutput });

      return {
        agent: params.agent, agentSource: meta.agentType as "user" | "project", task: params.task,
        exitCode: result.exitCode ?? 1, messages: result.messages, stderr: result.stderr,
        usage, model: params.model, stopReason, errorMessage: errorMsg,
        agentId: params.resumeAgentId, resumed: true,
      };
    } catch (err) {
      return {
        agent: params.agent, agentSource: meta.agentType as "user" | "project", task: params.task,
        exitCode: 1, messages: [], stderr: err instanceof Error ? err.message : String(err),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        agentId: params.resumeAgentId, resumed: true,
      };
    }
  }

  // --- Standard (non-resume) path ---
  if (!agentDef) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: params.agent, agentSource: "unknown", task: params.task, exitCode: 1,
      messages: [], stderr: `Unknown agent: "${params.agent}". Available: ${available}.`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    };
  }

  // Decide mode: fork or background → RPC; simple sync → print
  const useRpc = params.fork || params.background;

  // Generate agentId for ALL non-resume agents (not just RPC ones).
  // This enables worktree isolation and transcript storage.
  const agentId = params.resumeAgentId ??
    `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // Persist metadata (enable resume, auditing)
  writeAgentMetadata(cwd, agentId, {
    agentType: agentDef.name, name: params.agent, task: params.task,
    model: params.model ?? agentDef.model,
    tools: params.tools ?? agentDef.tools,
    forkMode: params.fork ?? false,
    background: params.background ?? false,
    createdAt: Date.now(),
  });

  // Record spawn in parent tree
  recordSubagentSpawn(pi, {
    agentId, agent: params.agent, task: params.task,
    model: params.model ?? agentDef.model,
    tools: params.tools ?? agentDef.tools,
    background: params.background ?? false,
    forkMode: params.fork ?? false,
    transcriptFile: `.pi/aim/agents/${agentId}.jsonl`,
  });

  const model = params.model ?? agentDef.model;
  const declaredTools = params.tools ?? agentDef.tools ?? [];

  // Apply role-based tool filtering (infrastructure-level enforcement).
  // Workers cannot re-delegate via subagent/send_message; teammates get
  // collaboration tools force-injected; coordinators get exclusive set.
  // This runs regardless of what the agent definition declares.
  const { getRoleTools, resolveRole } = await import("./permission-matrix.js");
  const isTeammate = (params as Record<string, unknown>).team_name !== undefined;
  const role = resolveRole({ isTeammate, isFork: params.fork });
  const tools = getRoleTools(role, declaredTools);

  // Build system prompt for fork mode: append agent's system prompt
  let systemPrompt: string | undefined;
  if (params.fork) {
    // Fork inherits parent context, but we also inject the agent's role prompt
    systemPrompt = agentDef.systemPrompt;
  }

  // If not fork mode and not background, use agent's system prompt directly
  if (!params.fork && !params.background) {
    systemPrompt = agentDef.systemPrompt;
  }

  // =======================================================================
  // Worktree isolation: create a git worktree copy of the project and
  // run the agent inside it. This prevents file conflicts between
  // concurrent agents and protects the main working directory.
  // =======================================================================
  const wt = createWorktree(cwd, agentId);
  const wtBaseDir: string | null = wt?.baseDir ?? null;
  const effectiveCwd = wt?.effectiveCwd ?? (params.cwd ?? cwd);

  const workerId = workerPool.spawn({
    name: params.agent, prompt: params.task,
    model, tools,
    cwd: effectiveCwd,
    background: params.background ?? false,
    systemPrompt,
    rpcMode: useRpc,
    agentId,
  });

  const info = workerPool.getInfo(workerId);
  if (!info) throw new Error("Worker spawn failed");

  onUpdate?.({ agent: params.agent, status: "running", output: "" });

  // P6: If this agent is associated with a task, update task metadata
  // to record the agentId (enables resume and progress tracking)
  if ((params as Record<string, unknown>).task_id) {
    const tid = (params as Record<string, unknown>).task_id as string;
    const activeTeam = getActiveTeam(cwd);
    if (activeTeam) {
      try {
        await updateTask(cwd, activeTeam, tid, {
          status: "in_progress",
          metadata: { agentId },
        });
      } catch (err) {
        console.warn(`[aim] Failed to associate agent ${agentId} with task #${tid}:`, err);
      }
    }
  }

  // P4: Create display state for this task
  const displayState = createDisplayState(agentId, {
    isForeground: !params.background,
    autoBackgroundAfterMs: params.background ? 0 : 60_000, // 60s auto-bg for foreground tasks
    retain: false,
  });

  if (params.background) {
    // P3: Persist progress for background tasks so they can be inspected later
    recordStatusChange(agentId, "background_launched");

    return {
      agent: params.agent, agentSource: agentDef.source, task: params.task,
      exitCode: -1, messages: [], stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      agentId, resumed: false,
    };
  }

  try {
    // RPC mode: waitFor resolves on agent_end (handled in attachStdout)
    // Process stays alive in idle state for multi-turn.
    // Print mode: waitFor resolves on process close after exit.
    const result = await workerPool.waitFor(workerId);
    const usage = collectUsage(result.messages);
    const finalOutput = getFinalOutput(result.messages);
    const lastAssistant = result.messages.filter(m => m.role === "assistant").pop() as Record<string, unknown> | undefined;
    const stopReason = lastAssistant?.stopReason as string | undefined;
    const errorMsg = lastAssistant?.errorMessage as string | undefined;

    // Persist transcript
    appendToTranscript(cwd, agentId, result.messages);
    recordSubagentResult(pi, {
      agentId, status: result.exitCode === 0 ? "completed" : "failed",
      summary: finalOutput.slice(0, 200), usage, exitCode: result.exitCode ?? 1, model,
    });

    // P6: Update associated task if task_id was provided
    if ((params as Record<string, unknown>).task_id) {
      const tid = (params as Record<string, unknown>).task_id as string;
      const activeTeam = getActiveTeam(cwd);
      if (activeTeam) {
        try {
          const taskUpdate: Partial<Pick<TaskItem, "status" | "metadata">> = {
            status: result.exitCode === 0 ? "completed" : "failed",
            metadata: {
              agentId,
              exitCode: result.exitCode ?? 1,
              completedAt: Date.now(),
            },
          };
          await updateTask(cwd, activeTeam, tid, taskUpdate);
        } catch (err) {
          console.warn(`[aim] Failed to update task #${tid} after agent completion:`, err);
        }
      }
    }

    // P3: Persist progress to disk before cleanup
    persistProgress(cwd, agentId);

    // P4: Mark task as completed in display state
    markCompleted(agentId);

    // P3: Clean up progress tracker (data already persisted)
    // Delay removal to allow renderers to read final state
    setTimeout(() => {
      removeProgressTracker(agentId);
      removeDisplayState(agentId);
      deletePersistedProgress(cwd, agentId);
    }, 5000);

    onUpdate?.({ agent: params.agent, status: result.exitCode === 0 ? "completed" : "error", output: finalOutput });

    return {
      agent: params.agent, agentSource: agentDef.source, task: params.task,
      exitCode: result.exitCode ?? 1, messages: result.messages, stderr: result.stderr,
      usage, model: params.model, stopReason, errorMessage: errorMsg,
      agentId, resumed: false,
    };
  } catch (err) {
    return {
      agent: params.agent, agentSource: agentDef.source, task: params.task,
      exitCode: 1, messages: [], stderr: err instanceof Error ? err.message : String(err),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      agentId, resumed: false,
    };
  } finally {
    // P4: Always clean up display state and progress on error
    if (agentId) {
      markCompleted(agentId);
      setTimeout(() => {
        removeProgressTracker(agentId);
        removeDisplayState(agentId);
      }, 5000);
    }
    // Always clean up worktree after agent completes
    if (wtBaseDir) {
      removeWorktreeByBase(cwd, wtBaseDir);
    }
  }
}

// ============================================================================
// Schema Definitions
// ============================================================================

const SubagentTaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate" }),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
  model: Type.Optional(Type.String({ description: "Model override" })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Tools to enable" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder" }),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
  model: Type.Optional(Type.String({ description: "Model override" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description: 'Agent directories. Default: "user".', default: "user",
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task (single mode)" })),
  tasks: Type.Optional(Type.Array(SubagentTaskItem, { description: "Parallel execution" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential execution" })),
  agentScope: Type.Optional(AgentScopeSchema),
  fork: Type.Optional(Type.Boolean({ description: "Fork current session (inherit context)", default: false })),
  background: Type.Optional(Type.Boolean({ description: "Run in background", default: false })),
  model: Type.Optional(Type.String({ description: "Model override" })),
  team_name: Type.Optional(Type.String({ description: "Team name for teammate spawn" })),
  teammate_name: Type.Optional(Type.String({ description: "Name for spawned teammate" })),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
  resume: Type.Optional(Type.String({ description: "Agent ID to resume (continue previous subagent conversation)" })),
  // P6: Task-system integration
  task_id: Type.Optional(Type.String({ description: "Associate this subagent with a task in the team's task list (P6)" })),
});

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {

  // Register the FindCandidateAgent callback to break the circular dependency
  // between shared-tasks.ts and agent-status.ts.
  // This allows shared-tasks.ts to find the least-busy idle agent for
  // unowned unblocked task notifications without importing agent-status.ts.
  registerFindCandidateAgent((cwd, team) => findLeastBusyAgent(cwd, team)?.agentId);

  // Register isAgentBusy callback to break the circular dependency
  // between shared-tasks.ts and agent-status.ts.
  // This allows claimTask to use the centralized busy-check logic.
  registerIsAgentBusy((cwd, team, agentName) => isAgentBusyStatus(cwd, team, agentName));

  // Register the nudge-sent marker callback to break the circular dependency
  // between task-notifications.ts and shared-tasks.ts.
  registerMarkNudgeSent(async (cwd, team, taskId) => {
    const task = getTask(cwd, team, taskId);
    if (task) {
      await updateTask(cwd, team, taskId, {
        metadata: { ...task.metadata, verificationNudgeSent: true },
      });
    }
  });

  // Clean up stale worktrees from previous crashed sessions
  // (runs once on extension init - see worktree.ts)
  import("./worktree.js").then(({ cleanupStaleWorktrees }) => {
    try { cleanupStaleWorktrees(process.cwd()); } catch {}
  });

  // ========== SUBAGENT TOOL ==========

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents with isolated context windows.",
      "Modes: single (agent+task), parallel (tasks array), chain (sequential with {previous} placeholder).",
      'Default agent scope is "user" (from ~/.pi/agent/agents).',
      "Use fork:true to inherit current session context (RPC mode, resumable).",
      "Use background:true for fire-and-forget (RPC mode, resumable).",
      "Use resume:<agentId> to continue a previous subagent conversation.",
    ].join(" "),
    promptSnippet: "Spawn a subagent to handle complex, multi-step tasks autonomously",
    promptGuidelines: [
      "Use subagent for complex, multi-step tasks that benefit from isolated context.",
      "Run independent subagents in parallel (tasks array) to maximize throughput (max 4 concurrent).",
      "Use fork:true for research tasks - the subagent inherits your context.",
      "Use background:true for long tasks - results arrive via notification.",
      "Use resume:<id> to continue a previous agent - look for agent IDs in prior subagent results.",
    ],
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const scope: AgentScope = params.agentScope ?? "user";
      const { agents } = discoverAgents(ctx.cwd, scope);
      const cwd = ctx.cwd;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const hasResume = Boolean(params.resume);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle) + Number(hasResume);

      if (modeCount !== 1) {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return {
          content: [{ type: "text", text: `Provide exactly one mode.\nAvailable agents: ${available}` }],
          details: { mode: "invalid" },
        };
      }

      // --- Resume ---
      if (params.resume) {
        const result = await runSingleAgent(pi, cwd, agents, {
          agent: "resumed", task: params.task ?? "",
          background: params.background, model: params.model,
          resumeAgentId: params.resume,
        }, signal, (up) => onUpdate?.({ content: [{ type: "text", text: `${up.agent}: ${up.status}` }], details: { mode: "resume", ...up } }));

        if (params.background) {
          return {
            content: [{ type: "text", text: `Resumed agent ${params.resume} in background.` }],
            details: { mode: "resume", background: true, agentId: result.agentId },
          };
        }
        // P7: Apply overflow protection to resume output
        const fullOutput = getFinalOutput(result.messages) || "(no output)";
        const overflow = handleResultOverflow(cwd, result.agentId ?? params.resume, fullOutput);
        return {
          content: [{ type: "text", text: overflow.display }],
          details: { mode: "resume", result, overflow },
        };
      }

      // --- Team spawn ---
      if (params.team_name) {
        const { spawnTeammate } = await import("./teams.js");
        const spawned = await spawnTeammate(cwd, {
          name: params.teammate_name ?? params.agent ?? "teammate",
          prompt: params.task ?? "", team_name: params.team_name,
          agent_type: params.agent, model: params.model,
        }, agents);
        return {
          content: [{ type: "text", text: `Teammate spawned: ${spawned.name} in ${spawned.team}. ID: ${spawned.agentId}` }],
          details: { mode: "teammate_spawned", ...spawned },
        };
      }

      // --- Chain ---
      if (params.chain?.length) {
        const results: SingleResult[] = [];
        let prev = "";
        for (let i = 0; i < params.chain.length; i++) {
          const s = params.chain[i];
          const r = await runSingleAgent(pi, cwd, agents, {
            agent: s.agent, task: s.task.replace(/\{previous\}/g, prev),
            cwd: s.cwd, model: s.model,
          }, signal, (up) => onUpdate?.({ content: [{ type: "text", text: `[${i + 1}/${params.chain!.length}] ${up.agent}: ${up.status}` }], details: { mode: "chain", step: i + 1, ...up } }));
          results.push(r);
          if (r.exitCode !== 0 && r.stopReason !== undefined) {
            const err = r.errorMessage || r.stderr || "(no output)";
            return { content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${s.agent}): ${err}` }], details: { mode: "chain", results, error: true }, isError: true };
          }
          prev = getFinalOutput(r.messages);
        }
        // P7: Apply overflow protection to chain's final output
        const finalOutput = getFinalOutput(results[results.length - 1].messages) || "(no output)";
        const finalAgentId = results[results.length - 1].agentId ?? results[results.length - 1].agent;
        const overflow = handleResultOverflow(cwd, finalAgentId, finalOutput);
        return { content: [{ type: "text", text: overflow.display }], details: { mode: "chain", results, overflow } };
      }

      // --- Parallel ---
      if (params.tasks?.length) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          return { content: [{ type: "text", text: `Max ${MAX_PARALLEL_TASKS} tasks.` }], details: { mode: "parallel", error: true } };
        }
        const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t) =>
          runSingleAgent(pi, cwd, agents, { agent: t.agent, task: t.task, cwd: t.cwd, model: t.model, tools: t.tools }, signal, (up) => onUpdate?.({ content: [{ type: "text", text: `[parallel] ${up.agent}: ${up.status}` }], details: { mode: "parallel", ...up } }))
        );
        const ok = results.filter(r => r.exitCode === 0).length;

        // ===========================================================================
        // P7: Result overflow protection — centralized via task-result-storage.ts
        //
        // All execution modes now use the same overflow handling:
        //   Phase 1: Per-agent results exceeding PER_AGENT_INLINE_LIMIT → persist to disk
        //   Phase 2: Per-message budget check → truncate all if total exceeds budget
        //   Parent agent uses read tool to access full output from persisted files.
        // ===========================================================================

        const batchItems = results.map(r => ({
          agentId: r.agentId ?? r.agent,
          fullOutput: getFinalOutput(r.messages),
          agentName: r.agent,
          exitCode: r.exitCode,
        }));

        const batch = handleBatchOverflow(cwd, batchItems);
        const agentNames = results.map(r => r.agent);
        const exitCodes = results.map(r => r.exitCode);
        const displayText = formatBatchOverflowDisplay(batch, agentNames, exitCodes, ok, results.length);

        return { content: [{ type: "text", text: displayText }], details: { mode: "parallel", results } };
      }

      // --- Single ---
      if (params.agent && params.task) {
        const result = await runSingleAgent(pi, cwd, agents, {
          agent: params.agent, task: params.task,
          fork: params.fork, background: params.background,
          cwd: params.cwd, model: params.model,
          task_id: params.task_id, // P6: pass task_id for task-system integration
        }, signal, (up) => onUpdate?.({ content: [{ type: "text", text: `${up.agent}: ${up.status}` }], details: { mode: "single", ...up } }));

        if (params.background) {
          return { content: [{ type: "text", text: `Background agent "${params.agent}" launched. Agent ID: ${result.agentId}. Use resume: to continue.` }], details: { mode: "single", background: true, agentId: result.agentId } };
        }
        if (result.exitCode !== 0 && result.stopReason !== undefined) {
          const err = result.errorMessage || result.stderr || "(no output)";
          return { content: [{ type: "text", text: `Agent ${result.stopReason}: ${err}` }], details: { mode: "single", result }, isError: true };
        }
        // P7: Apply overflow protection to single agent output
        const fullOutput = getFinalOutput(result.messages) || "(no output)";
        const overflow = handleResultOverflow(cwd, result.agentId ?? result.agent, fullOutput);
        return { content: [{ type: "text", text: overflow.display }], details: { mode: "single", result, overflow } };
      }

      return { content: [{ type: "text", text: `Invalid params. Available: ${agents.map(a => a.name).join(", ") || "none"}` }], details: { mode: "invalid" } };
    },

    // ========== RENDER ==========

    renderCall(args, theme, _context) {
      const scope: AgentScope = args.agentScope ?? "user";
      if (args.resume) {
        return new Text(theme.fg("toolTitle", theme.bold("subagent resume ")) + theme.fg("accent", args.resume) + theme.fg("dim", ` ${(args.task ?? "").slice(0, 60)}`), 0, 0);
      }
      if (args.chain?.length) {
        let t = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `chain (${args.chain.length} steps)`) + theme.fg("muted", ` [${scope}]`);
        for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
          const s = args.chain[i]; const p = s.task.replace(/\{previous\}/g, "").trim().slice(0, 40);
          t += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", s.agent)}${theme.fg("dim", ` ${p}`)}`;
        }
        if (args.chain.length > 3) t += `\n  ${theme.fg("muted", `+${args.chain.length - 3} more`)}`;
        return new Text(t, 0, 0);
      }
      if (args.tasks?.length) {
        let t = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length})`) + theme.fg("muted", ` [${scope}]`);
        for (const x of args.tasks.slice(0, 3)) t += `\n  ${theme.fg("accent", x.agent)}${theme.fg("dim", ` ${x.task.slice(0, 40)}`)}`;
        if (args.tasks.length > 3) t += `\n  ${theme.fg("muted", `+${args.tasks.length - 3} more`)}`;
        return new Text(t, 0, 0);
      }
      let t = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", args.agent ?? "...") + theme.fg("muted", ` [${scope}]`);
      t += `\n  ${theme.fg("dim", (args.task ?? "").slice(0, 60))}`;
      if (args.fork) t += ` ${theme.fg("warning", "(fork)")}`;
      if (args.background) t += ` ${theme.fg("warning", "(background)")}`;
      return new Text(t, 0, 0);
    },

    renderResult(result, { expanded }, theme, _ctx) {
      const details = result.details as Record<string, unknown> | undefined;
      if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
      const mdTheme = getMarkdownTheme();

      if (details.mode === "single" || details.mode === "resume") {
        const r = details.result as SingleResult | undefined;
        if (r) return renderSubagentResult(result, expanded, theme, r.agent, r.agentSource, r.task, r.model, r.usage, r.stopReason, r.errorMessage);
      }

      if (details.mode === "chain") {
        const results = (details.results ?? []) as SingleResult[];
        const ok = results.filter(r => r.exitCode === 0).length;
        const icon = ok === results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
        if (expanded) {
          const c = new Container();
          c.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${ok}/${results.length} steps`)}`, 0, 0));
          for (const r of results) {
            const ri = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
            c.addChild(new Spacer(1));
            c.addChild(new Text(`${theme.fg("muted", `Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${ri}`, 0, 0));
            c.addChild(new Text(theme.fg("dim", r.task), 0, 0));
            for (const item of getDisplayItems(r.messages).filter(x => x.type === "toolCall")) {
              c.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args as Record<string, unknown>, theme), 0, 0));
            }
            const out = getFinalOutput(r.messages); if (out) { c.addChild(new Spacer(1)); c.addChild(new Markdown(out.trim(), 0, 0, mdTheme)); }
            const u = formatUsageStats(r.usage, r.model); if (u) c.addChild(new Text(theme.fg("dim", u), 0, 0));
          }
          const totalU = formatUsageStats(results.reduce((s, r) => ({ input: s.input + r.usage.input, output: s.output + r.usage.output, cacheRead: s.cacheRead + r.usage.cacheRead, cacheWrite: s.cacheWrite + r.usage.cacheWrite, cost: s.cost + r.usage.cost, turns: s.turns + r.usage.turns }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }));
          if (totalU) { c.addChild(new Spacer(1)); c.addChild(new Text(theme.fg("dim", `Total: ${totalU}`), 0, 0)); }
          return c;
        }
        let t = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${ok}/${results.length}`)}`;
        for (const r of results) {
          const ri = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
          t += `\n${theme.fg("accent", r.agent)} ${ri}`;
          const items = getDisplayItems(r.messages).slice(-5);
          for (const i of items) t += `\n  ${i.type === "text" ? theme.fg("toolOutput", i.text) : theme.fg("muted", "→ ") + formatToolCall(i.name, i.args as Record<string, unknown>, theme)}`;
        }
        t += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(t, 0, 0);
      }

      if (details.mode === "parallel") {
        const results = (details.results ?? []) as SingleResult[];
        const running = results.filter(r => r.exitCode === -1).length;
        const ok = results.filter(r => r.exitCode === 0).length;
        const fail = results.filter(r => r.exitCode > 0).length;
        const icon = running > 0 ? theme.fg("warning", "⏳") : fail > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
        const st = running > 0 ? `${ok + fail}/${results.length} done, ${running} running` : `${ok}/${results.length}`;
        let t = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", st)}`;
        for (const r of results) {
          const ri = r.exitCode === -1 ? theme.fg("warning", "⏳") : r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
          t += `\n${theme.fg("accent", r.agent)} ${ri}`;
          const items = getDisplayItems(r.messages).slice(-3);
          for (const i of items) t += `\n  ${i.type === "text" ? theme.fg("toolOutput", i.text) : theme.fg("muted", "→ ") + formatToolCall(i.name, i.args as Record<string, unknown>, theme)}`;
        }
        return new Text(t, 0, 0);
      }

      const content = result.content[0];
      return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
    },
  });

  // ========== REGISTER SUBSYSTEMS ==========

  registerSendMessage(pi);
  registerCoordinator(pi);
  registerTeams(pi);
  registerPermissions(pi);
  registerSwarm(pi);

  // ========== P5: TASK TOOLS ==========
  registerTaskCreateTool(pi);
  registerTaskUpdateTool(pi);
  registerTaskOutputTool(pi);
  registerTaskListTool(pi);

  // ========== P6: TASK RESUME TOOL ==========
  pi.registerTool({
    name: "task_resume",
    label: "TaskResume",
    description: [
      "Resume an interrupted task by re-spawning its agent with existing context.",
      "Useful after crashes or session restarts.",
      "Only in_progress tasks can be resumed.",
      "Also supports recovering all orphaned tasks at once (orphan_recovery=true).",
    ].join(" "),
    promptSnippet: "Resume an interrupted task or recover orphaned tasks",
    promptGuidelines: [
      "Use task_resume to continue tasks interrupted by crashes.",
      "Set orphan_recovery=true to find and resume all stuck tasks.",
    ],
    parameters: Type.Object({
      task_id: Type.Optional(Type.String({ description: "Task ID to resume" })),
      orphan_recovery: Type.Optional(Type.Boolean({ description: "Find and recover all orphaned tasks (default: false)", default: false })),
      kill_unresumable: Type.Optional(Type.Boolean({ description: "Kill orphans that can't be resumed (default: true)", default: true })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const team = getActiveTeam(ctx.cwd);
      if (!team) {
        return {
          content: [{ type: "text", text: "No active team. Create a team first with team_create." }],
          isError: true,
        };
      }

      // --- Orphan recovery mode ---
      if (params.orphan_recovery) {
        const result = await recoverOrphanTasks(ctx.cwd, team, {
          killUnresumable: params.kill_unresumable ?? true,
          signal,
        });

        const lines: string[] = [
          `🔧 Orphan recovery complete:`,
          `   ✅ Resumed: ${result.resumed}`,
          `   💀 Killed: ${result.killed}`,
          `   ❌ Failed: ${result.failed}`,
        ];

        for (const detail of result.details) {
          const icon = detail.action === "resumed" ? "✅" : detail.action === "killed" ? "💀" : "❌";
          const err = detail.error ? ` (${detail.error})` : "";
          lines.push(`   ${icon} Task #${detail.taskId}: ${detail.action}${err}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { result },
        };
      }

      // --- Single task resume ---
      if (!params.task_id) {
        return {
          content: [{ type: "text", text: "Provide task_id or set orphan_recovery=true." }],
          isError: true,
        };
      }

      const result = await resumeTask(ctx.cwd, team, params.task_id, { signal });

      if (!result.success) {
        return {
          content: [{ type: "text", text: `❌ Resume failed: ${result.error}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: [
            `✅ Task #${params.task_id} resumed.`,
            `   Agent ID: ${result.agentId}`,
            `   Status: ${result.task?.status ?? "unknown"}`,
          ].join("\n"),
        }],
        details: { result },
      };
    },

    renderCall(args, theme) {
      if (args.orphan_recovery) {
        return new Text(theme.fg("toolTitle", theme.bold("task_resume ")) + theme.fg("warning", "orphan recovery"), 0, 0);
      }
      return new Text(
        theme.fg("toolTitle", theme.bold("task_resume ")) + theme.fg("accent", `#${args.task_id ?? "?"}`),
        0, 0,
      );
    },

    renderResult(result, _opts, theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";
      const isError = result.isError;
      return new Text(
        isError ? theme.fg("error", text) : theme.fg("success", text),
        0, 0,
      );
    },
  });

  // ========== P2: LEAD INBOX POLLER ==========
  // Start the lead inbox poller when a team is active.
  // The poller runs as a background loop that processes:
  //   - idle notifications → distribute tasks to idle agents
  //   - permission requests → forward to user for approval
  //   - task completion events → distribute newly unblocked tasks
  // The poller is automatically stopped when the session ends
  // (the AbortSignal from the session is passed through).

  // We track the active lead poller so it can be stopped/restarted
  // when teams are created/deleted.
  let leadPollerController: AbortController | null = null;

  // The lead poller needs a permission request handler that can
  // present the request to the user via pi's UI. This bridges
  // the mailbox-based permission system with pi's existing
  // ToolUseConfirm dialog.
  const DANGEROUS_COMMAND_PATTERNS = /rm\s+-[a-zA-Z]*f|sudo\s|mkfs|dd\s+if|format\s|del\s+\/[sS]|\bchmod\s+777|\bchown\s+root|>\s*\/dev\/sd/i;

  const leadPermissionHandler: PermissionRequestHandler = async (
    requestId, agentName, toolName, toolArgs,
  ) => {
    // Present the permission request to the user via pi's sendMessage.
    try {
      const commandStr = typeof toolArgs.command === "string"
        ? toolArgs.command
        : JSON.stringify(toolArgs);
      const summary = commandStr.slice(0, 80);

      // Block dangerous commands automatically — these must never be
      // auto-approved even if a full ToolUseConfirm integration isn't ready.
      if (DANGEROUS_COMMAND_PATTERNS.test(commandStr)) {
        pi.sendMessage({
          role: "user",
          content: `🔐 ⛔ Permission DENIED from ${agentName}: ${toolName}(${summary}) — dangerous command blocked.`,
        });
        return { approved: false, reason: "Dangerous command blocked by safety filter" };
      }

      pi.sendMessage({
        role: "user",
        content: `🔐 Permission request from ${agentName}: ${toolName}(${summary})`,
      });
      // Auto-approve non-dangerous commands — a full implementation would use
      // pi's ToolUseConfirm mechanism to get actual user approval.
      // This requires deeper integration with pi's permission system
      // which is planned for a future iteration.
      return { approved: true };
    } catch {
      return { approved: false, reason: "Failed to present permission request to user" };
    }
  };

  // Stale task cleanup: periodically kill orphaned in_progress tasks
  // Returns a cleanup function that clears the interval when called.
  const startStaleTaskCleanup = (teamName: string, cwd: string) => {
    const interval = setInterval(async () => {
      try {
        const cleaned = await cleanupStaleTasks(cwd, teamName);
        if (cleaned > 0) {
          console.info(`[aim] Cleaned up ${cleaned} stale tasks`);
        }
      } catch (err) {
        console.warn("[aim] Stale task cleanup failed:", err);
      }
    }, 1_800_000); // 30 minutes
    return () => clearInterval(interval);
  };

  // Track cleanup handles for proper teardown on session end
  const cleanupHandles: Array<() => void> = [];

  // Function to start/restart the lead poller for a given team
  const startLeadPollerForTeam = (teamName: string, cwd: string) => {
    // Stop existing poller if any
    if (leadPollerController) {
      leadPollerController.abort();
    }
    leadPollerController = new AbortController();

    startLeadPoller({
      cwd,
      teamName,
      signal: leadPollerController.signal,
      onPermissionRequest: leadPermissionHandler,
      onDistribution: (result) => {
        if (result.assigned) {
          pi.sendMessage({
            role: "user",
            content: `📋 Task #${result.taskId} assigned to ${result.agentName}`,
          });
        }
      },
    }).catch(err => {
      if (!(err instanceof Error && err.message.includes("aborted"))) {
        console.warn("[aim] Lead poller error:", err);
      }
    });

    // Start stale task cleanup for this team and save the cleanup handle
    const cleanup = startStaleTaskCleanup(teamName, cwd);
    cleanupHandles.push(cleanup);
  };

  // Auto-start lead poller when a team is active
  const activeTeam = getActiveTeam(process.cwd());
  if (activeTeam) {
    startLeadPollerForTeam(activeTeam, process.cwd());
  }

  // ========== P4: DISPLAY TRANSITION CALLBACKS ==========
  // When a task transitions to background, notify the user.
  // When a task is evicted, clean up resources.
  onDisplayTransition((id, isFg) => {
    if (!isFg) {
      // Task moved to background — inform the user
      const progress = getProgressTracker(id);
      const status = progress ? generateCompactSummary(id) : "running";
      pi.sendMessage({
        role: "user",
        content: `⏸️ Task ${id} moved to background (${status})`,
      });
    }
  });

  onEvict((id) => {
    // Clean up progress and display state for evicted tasks
    removeProgressTracker(id);
    deletePersistedProgress(process.cwd(), id);
  });

  // P3+P4: Periodic cleanup of stale progress trackers and completed display states
  // P7: Also clean up old result files from disk
  // Runs every 5 minutes. Timer reference is tracked for cleanup on session end.
  const periodicCleanupTimer = setInterval(() => {
    import("./task-progress.js").then(({ cleanupStaleProgress }) => {
      const progressCleaned = cleanupStaleProgress();
      const displayCleaned = cleanupCompletedDisplayStates();
      const resultFilesCleaned = cleanupResultFiles(process.cwd());
      if (progressCleaned > 0 || displayCleaned > 0 || resultFilesCleaned > 0) {
        console.info(`[aim] Cleanup: ${progressCleaned} stale progress, ${displayCleaned} display states, ${resultFilesCleaned} result files removed`);
      }
    });
  }, 300_000);
  cleanupHandles.push(() => clearInterval(periodicCleanupTimer));

  // ========== P8: TASK EVENT MESSAGE RENDERER ==========
  // Register a custom renderer for task-system notification messages.
  // When a task event (assignment, completion, unblocked, etc.) arrives
  // via the mailbox system or pi.sendMessage, this renderer intercepts
  // it and produces a styled TUI display instead of raw JSON.
  //
  // The renderer is keyed on "aim-task-event" — messages sent with
  // pi.sendMessage({ ... details: { type: "aim-task-event" } }) will
  // be routed here. For mailbox-based notifications (JSON in content),
  // the renderTaskEventText function is used directly by the lead poller
  // and task-list tool.

  const TASK_EVENT_TYPE = "aim-task-event";

  pi.registerMessageRenderer<TaskNotification>(TASK_EVENT_TYPE, (message, _options, theme) => {
    const notif = message.details as TaskNotification | undefined;
    if (!notif) {
      // Fallback: try parsing from content
      const content = typeof message.content === "string" ? message.content : "";
      try {
        const parsed = JSON.parse(content) as TaskNotification;
        return new Text(renderTaskEvent(parsed, theme), 0, 0);
      } catch {
        return undefined;
      }
    }
    return new Text(renderTaskEvent(notif, theme), 0, 0);
  });
}