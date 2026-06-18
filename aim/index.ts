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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// ── Tool registration ──
import { registerSubagentTool } from "./subagent-tool.js";
import { registerTaskResumeTool } from "./task-resume-tool.js";
import { registerTaskCreateTool } from "./task-create-tool.js";
import { registerTaskUpdateTool } from "./task-update-tool.js";
import { registerTaskOutputTool } from "./task-output-tool.js";
import { registerTaskListTool } from "./task-list-tool.js";

// ── Subsystem registration ──
import { registerSendMessage } from "./send-message.js";
import { registerCoordinator } from "./coordinator.js";
import { registerTeams } from "./teams.js";
import { registerPermissions } from "./permissions.js";
import { registerSwarm } from "./swarm.js";

// ── Lifecycle ──
import { wireCallbacks, startLifecycleServices } from "./extension-lifecycle.js";

// ── Message renderer ──
import type { TaskNotification } from "./task-notifications.js";
import { renderTaskEvent } from "./task-render.js";

// ============================================================================
// Re-exports (backward compatibility for other extensions)
// ============================================================================

export { workerPool } from "./worker-pool.js";
export { readMailbox, writeToMailbox, markMessageAsRead, isShutdownRequest, isPermissionResponse, createShutdownRequest, createShutdownApproval, createShutdownRejection, createIdleNotification, parseStructuredMessage, createPlanApprovalRequest, createPlanApprovalResponse, Mailbox } from "./mailbox.js";
export { discoverAgents, formatAgentList } from "./agents.js";
export { createTeam, deleteTeam, spawnTeammate, getActiveTeam } from "./teams.js";
export { pollInbox, sendIdleNotification } from "./poller.js";
export { notifyTaskAssignment, notifyTaskUnblocked, notifyTaskCompleted, nudgeVerification, registerMarkNudgeSent, type TaskNotification } from "./task-notifications.js";
export { startLeadPoller, type LeadPollerConfig, type PermissionRequestHandler } from "./lead-poller.js";
export { handleIdleAgent, distributeAvailableTasks, handleTaskCompleted, type DistributionResult } from "./task-distributor.js";
export { requestPermissionViaMailbox, isTeammateProcess, needsMailboxPermission, type PermissionResult } from "./permission-sync.js";
export { registerTaskCreateTool } from "./task-create-tool.js";
export { registerTaskUpdateTool } from "./task-update-tool.js";
export { registerTaskOutputTool } from "./task-output-tool.js";
export { registerTaskListTool } from "./task-list-tool.js";
export { resumeTask, findOrphanTasks, recoverOrphanTasks, type ResumeResult, type OrphanTask } from "./task-resume.js";
export {
  createProgressTracker, recordToolUse, recordTokenUsage, recordTurn,
  recordStatusChange, recordError, removeProgressTracker,
  persistProgress, deletePersistedProgress, loadProgress,
  getProgressTracker, generateProgressSummary, generateCompactSummary,
  formatTokenUsage, formatTokenCount,
  ProgressTracker, progressTracker,
  type TaskProgress, type TokenUsage, type ActivityEntry,
} from "./task-progress.js";
export {
  createDisplayState, backgroundTask, foregroundTask, backgroundAll,
  markCompleted, evictTask, resetAutoBackgroundTimer,
  removeDisplayState, clearAllDisplayStates, cleanupCompletedDisplayStates,
  getDisplayState, isForeground as isTaskForeground,
  getForegroundTasks, getBackgroundTasks, hasForegroundTasks,
  formatDisplayStateSummary, formatBackgroundTaskList,
  DisplayManager, displayManager,
  type TaskDisplayState, type TransitionResult,
} from "./task-foreground.js";
export { writeAgentMetadata, readAgentMetadata, appendToTranscript, readTranscript, recordSubagentSpawn, recordSubagentResult } from "./aim-transcript.js";
export {
  listTasks, createTask, updateTask, claimTask, findAvailableTask,
  deleteTask, blockTask, unblockTask, findUnblockedTasks, isAgentBusy, getAgentTasks, getTask,
  cleanupStaleTasks,
  isTerminalStatus, canTransition, VALID_TRANSITIONS,
  type TaskItem, type TaskStatus, type TaskType, type CreateTaskOptions,
  registerTaskCreatedHook, registerTaskCompletedHook, registerTaskTransitionHook,
  type HookResult, type HookContext, type TaskCreatedHook, type TaskCompletedHook, type TaskTransitionHook,
  registerFindCandidateAgent, forceTaskStatus,
  registerIsAgentBusy,
  type UpdateTaskOptions, type FindCandidateAgentFn, type IsAgentBusyFn,
} from "./shared-tasks.js";
export {
  isAgentBusyStatus, getAgentStatus, getTeamAgentStatuses, getTeamStatusSnapshot,
  findLeastBusyAgent, getAgentOpenTasks, formatAgentStatuses,
  AgentStatusManager,
  type AgentStatus, type AgentBusyState, type TeamAgentStatusSnapshot,
} from "./agent-status.js";
export {
  handleResultOverflow, handleBatchOverflow,
  readPersistedResult, isResultPersisted, getPersistedResultPath,
  formatOverflowDisplay, formatBatchOverflowDisplay,
  cleanupResultFiles,
  PER_AGENT_INLINE_LIMIT, PER_AGENT_PREVIEW_BYTES, PER_MESSAGE_BUDGET,
  type OverflowResult, type BatchOverflowResult,
} from "./task-result-storage.js";
export {
  renderTaskList, renderTaskListText, renderTaskDetail,
  renderAgentStatuses, renderAgentStatusesText,
  renderTaskEvent, renderTaskEventText,
  renderProgressInline, renderProgressDetail,
  renderDashboard, renderDashboardText,
  renderTaskBadge,
} from "./task-render.js";
export { executeAgent, type ExecutionContext, type AgentExecutionParams, type AgentExecutionResult, type UsageSummary, type AgentUpdate } from "./agent-executor.js";
export { acquireFileLock } from "./lock.js";
export { formatResultError, formatResultCompact, collectTotalUsage } from "./agent-result.js";
export { agentStarted, agentCompleted, agentFailed, agentResumed, agentBackgroundLaunched } from "./agent-lifecycle.js";
export type { WorkerConfig, WorkerInfo, AgentConfig, AgentScope, AgentDiscoveryResult, TeammateMessage, TeamFile, TeamMember, SubagentSpawnData, SubagentResultData } from "./types.js";

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {
  // 1. Wire cross-module callbacks (break circular dependencies)
  wireCallbacks(pi);

  // 2. Clean up stale worktrees from previous crashed sessions
  import("./worktree.js").then(({ cleanupStaleWorktrees }) => {
    try { cleanupStaleWorktrees(process.cwd()); } catch {}
  });

  // 3. Register tools
  registerSubagentTool(pi);
  registerTaskResumeTool(pi);
  registerTaskCreateTool(pi);
  registerTaskUpdateTool(pi);
  registerTaskOutputTool(pi);
  registerTaskListTool(pi);

  // 4. Register subsystems
  registerSendMessage(pi);
  registerCoordinator(pi);
  registerTeams(pi);
  registerPermissions(pi);
  registerSwarm(pi);

  // 5. Start lifecycle services (lead poller, periodic cleanup, callbacks)
  const stopLifecycle = startLifecycleServices(pi);
  // TODO: call stopLifecycle() on session end when pi provides a session-end hook

  // 6. Register task event message renderer
  const TASK_EVENT_TYPE = "aim-task-event";
  pi.registerMessageRenderer<TaskNotification>(TASK_EVENT_TYPE, (message, _options, theme) => {
    const notif = message.details as TaskNotification | undefined;
    if (!notif) {
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
