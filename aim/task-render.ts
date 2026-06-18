/**
 * AIM — Task Render (P8)
 *
 * Unified rendering components for task system UI.
 * Provides consistent visual presentation across all task-related displays.
 *
 * Design mirrors Claude Code's task UI components:
 *   - Task list: grouped by status (kanban-style)
 *   - Agent status: busy/idle indicators
 *   - Task events: structured notifications for assignments, completions, etc.
 *   - Progress bars: real-time progress from P3 trackers
 *   - Dashboard: combined view for /tasks command
 *
 * Integration points:
 *   - index.ts: registerMessageRenderer for task events
 *   - task-list-tool.ts: uses renderTaskList for /task_list output
 *   - render.ts: uses renderProgressInline for subagent results
 *   - task-notifications.ts: uses renderTaskEvent for notification messages
 */

import { Container, Text, Spacer } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
// (Markdown import removed — unused)
import { formatTokenCount } from "./task-progress.js";
import {
  isTerminalStatus,
  type TaskItem,
  type TaskStatus,
  type TaskType,
} from "./types.js";
import type { AgentStatus } from "./agent-status.js";
import {
  getProgressTracker,
  generateCompactSummary,
  type TaskProgress,
} from "./task-progress.js";
import type { TaskDisplayState } from "./task-foreground.js";
import type { TaskNotification } from "./task-notifications.js";

// ============================================================================
// Status Icons & Colors
// ============================================================================

const STATUS_ICON: Record<TaskStatus, string> = {
  pending: "⏳",
  in_progress: "🔄",
  completed: "✅",
  failed: "❌",
  killed: "💀",
};

const TASK_TYPE_ICON: Record<TaskType, string> = {
  local_agent: "🤖",
  in_process_teammate: "👥",
  local_bash: "💻",
  local_workflow: "🔗",
  monitor: "👁️",
  dream: "💭",
};

/** Get a theme color key for a task status */
function statusColorKey(status: TaskStatus): "success" | "warning" | "error" | "muted" | "accent" {
  switch (status) {
    case "completed": return "success";
    case "in_progress": return "accent";
    case "pending": return "muted";
    case "failed": return "error";
    case "killed": return "error";
  }
}

// ============================================================================
// Single Task Rendering
// ============================================================================

/**
 * Render a single task as a formatted line.
 * Used in task lists, notifications, and status displays.
 *
 * Format: {icon} #{id}: {subject} ({owner}) [blocked by: ...]
 */
export function renderTaskLine(task: TaskItem, theme: Theme): string {
  const icon = STATUS_ICON[task.status];
  const typeIcon = TASK_TYPE_ICON[task.type] ?? "";
  const owner = task.owner ? ` (${task.owner})` : "";
  const blocked = task.blockedBy.length > 0
    ? ` ${theme.fg("warning", `[blocked by: #${task.blockedBy.join(", #")}]`)}`
    : "";
  const activeForm = task.activeForm && task.status === "in_progress"
    ? ` — ${task.activeForm}`
    : "";
  const colorKey = statusColorKey(task.status);

  return [
    `${icon} ${typeIcon}`,
    theme.fg(colorKey, `#${task.id}: ${task.subject}${activeForm}`),
    theme.fg("dim", owner),
    blocked,
  ].join(" ");
}

/**
 * Render a single task as a detailed block (expanded view).
 * Includes description, metadata, timestamps, and progress.
 */
export function renderTaskDetail(task: TaskItem, theme: Theme, cwd?: string): Container {
  const container = new Container();
  const icon = STATUS_ICON[task.status];
  const colorKey = statusColorKey(task.status);

  // Header line
  container.addChild(new Text(
    `${icon} ${theme.fg(colorKey, theme.bold(`Task #${task.id}: ${task.subject}`))}`,
    0, 0,
  ));

  // Status row
  const statusParts: string[] = [
    `Status: ${theme.fg(colorKey, task.status)}`,
    `Type: ${task.type}`,
  ];
  if (task.owner) statusParts.push(`Owner: ${theme.fg("accent", task.owner)}`);
  if (task.activeForm && task.status === "in_progress") {
    statusParts.push(`Activity: ${task.activeForm}`);
  }
  container.addChild(new Text(theme.fg("dim", statusParts.join(" | ")), 0, 0));

  // Description
  if (task.description) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", task.description), 0, 0));
  }

  // Dependencies
  if (task.blockedBy.length > 0 || task.blocks.length > 0) {
    container.addChild(new Spacer(1));
    const depParts: string[] = [];
    if (task.blockedBy.length > 0) {
      depParts.push(`Blocked by: ${task.blockedBy.map(id => `#${id}`).join(", ")}`);
    }
    if (task.blocks.length > 0) {
      depParts.push(`Blocks: ${task.blocks.map(id => `#${id}`).join(", ")}`);
    }
    container.addChild(new Text(theme.fg("warning", depParts.join(" | ")), 0, 0));
  }

  // Metadata
  if (task.metadata && Object.keys(task.metadata).length > 0) {
    // Show selected metadata fields
    const metaParts: string[] = [];
    if (task.metadata.agentId) metaParts.push(`Agent: ${task.metadata.agentId}`);
    if (task.metadata.exitCode !== undefined) metaParts.push(`Exit: ${task.metadata.exitCode}`);
    if (task.metadata.failureReason) metaParts.push(`Reason: ${task.metadata.failureReason}`);
    if (task.metadata.forceReason) metaParts.push(`Force: ${task.metadata.forceReason}`);
    if (metaParts.length > 0) {
      container.addChild(new Text(theme.fg("dim", metaParts.join(" | ")), 0, 0));
    }
  }

  // Progress (if in_progress and tracker available)
  if (task.status === "in_progress" && task.metadata?.agentId) {
    const progress = getProgressTracker(task.metadata.agentId as string);
    if (progress) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(renderProgressInline(progress, theme), 0, 0));
    }
  }

  // Timestamps
  container.addChild(new Spacer(1));
  const timeParts: string[] = [
    `Created: ${new Date(task.createdAt).toLocaleTimeString()}`,
    `Updated: ${new Date(task.updatedAt).toLocaleTimeString()}`,
  ];
  if (isTerminalStatus(task.status) && task.metadata?.completedAt) {
    timeParts.push(`Completed: ${new Date(task.metadata.completedAt as number).toLocaleTimeString()}`);
  }
  container.addChild(new Text(theme.fg("dim", timeParts.join(" | ")), 0, 0));

  return container;
}

// ============================================================================
// Task List Rendering (Kanban-style)
// ============================================================================

/**
 * Render a task list grouped by status (kanban-style).
 * Each status group shows its tasks sorted by ID.
 *
 * Layout:
 *   📋 Task List — {team}
 *
 *   🔄 In Progress (2):
 *     🔄 #3: Fix login bug (worker-1) — Fixing auth flow
 *     🔄 #5: Update docs (worker-2)
 *
 *   ⏳ Pending (3):
 *     ⏳ #6: Write tests [blocked by: #3]
 *     ⏳ #7: Deploy
 *     ⏳ #8: Review
 *
 *   ✅ Completed (1):
 *     ✅ #1: Setup project
 *
 *   ❌ Failed (0):
 */
export function renderTaskList(
  tasks: TaskItem[],
  theme: Theme,
  teamName?: string,
): Container {
  const container = new Container();

  // Header
  const teamLabel = teamName ? ` — ${teamName}` : "";
  container.addChild(new Text(
    theme.fg("toolTitle", theme.bold(`📋 Task List${teamLabel}`)),
    0, 0,
  ));

  if (tasks.length === 0) {
    container.addChild(new Text(theme.fg("dim", "  No tasks"), 0, 0));
    return container;
  }

  // Group by status (maintain display order)
  const statusOrder: TaskStatus[] = ["in_progress", "pending", "completed", "failed", "killed"];
  const groups = new Map<TaskStatus, TaskItem[]>();
  for (const task of tasks) {
    const group = groups.get(task.status) ?? [];
    group.push(task);
    groups.set(task.status, group);
  }

  for (const status of statusOrder) {
    const group = groups.get(status);
    if (!group || group.length === 0) {
      // Show empty groups with count=0 for in_progress and pending
      if (status === "in_progress" || status === "pending") {
        container.addChild(new Spacer(1));
        container.addChild(new Text(
          `${STATUS_ICON[status]} ${statusLabel(status)} (0)`,
          0, 0,
        ));
      }
      continue;
    }

    container.addChild(new Spacer(1));
    const colorKey = statusColorKey(status);
    container.addChild(new Text(
      `${STATUS_ICON[status]} ${theme.fg(colorKey, theme.bold(`${statusLabel(status)} (${group.length}):`))}`,
      0, 0,
    ));

    for (const task of group) {
      container.addChild(new Text(`  ${renderTaskLine(task, theme)}`, 0, 0));
    }
  }

  return container;
}

/**
 * Render a compact task list as plain text (for tool responses).
 * Less detailed than the Container version but suitable for inline display.
 */
export function renderTaskListText(
  tasks: TaskItem[],
  teamName?: string,
): string {
  const lines: string[] = [];
  const teamLabel = teamName ? ` — ${teamName}` : "";
  lines.push(`📋 Task List${teamLabel}`);

  if (tasks.length === 0) {
    lines.push("  No tasks");
    return lines.join("\n");
  }

  const statusOrder: TaskStatus[] = ["in_progress", "pending", "completed", "failed", "killed"];
  const groups = new Map<TaskStatus, TaskItem[]>();
  for (const task of tasks) {
    const group = groups.get(task.status) ?? [];
    group.push(task);
    groups.set(task.status, group);
  }

  for (const status of statusOrder) {
    const group = groups.get(status);
    if (!group || group.length === 0) continue;

    lines.push("");
    lines.push(`${STATUS_ICON[status]} ${statusLabel(status)} (${group.length}):`);

    for (const task of group) {
      const owner = task.owner ? ` (${task.owner})` : "";
      const blocked = task.blockedBy.length > 0
        ? ` [blocked by: #${task.blockedBy.join(", #")}]`
        : "";
      const activeForm = task.activeForm && task.status === "in_progress"
        ? ` — ${task.activeForm}`
        : "";
      lines.push(`  ${STATUS_ICON[task.status]} ${TASK_TYPE_ICON[task.type] ?? ""} #${task.id}: ${task.subject}${activeForm}${owner}${blocked}`);
    }
  }

  return lines.join("\n");
}

// ============================================================================
// Agent Status Rendering
// ============================================================================

/**
 * Render agent statuses for the task dashboard.
 * Shows busy/idle state and current task assignments.
 */
export function renderAgentStatuses(
  agents: AgentStatus[],
  theme: Theme,
): Container {
  const container = new Container();

  container.addChild(new Text(
    theme.fg("toolTitle", theme.bold("👥 Agents")),
    0, 0,
  ));

  if (agents.length === 0) {
    container.addChild(new Text(theme.fg("dim", "  No agents"), 0, 0));
    return container;
  }

  for (const agent of agents) {
    const icon = agent.status === "busy" ? "🔴" : "🟢";
    const tasks = agent.currentTasks.length
      ? ` → ${agent.currentTasks.map(id => `#${id}`).join(", ")}`
      : "";
    const lastActive = agent.lastActiveAt
      ? ` (last: ${new Date(agent.lastActiveAt).toLocaleTimeString()})`
      : "";
    container.addChild(new Text(
      `  ${icon} ${theme.fg("accent", agent.name)}${theme.fg("dim", `${tasks}${lastActive}`)}`,
      0, 0,
    ));
  }

  return container;
}

/**
 * Render agent statuses as plain text.
 */
export function renderAgentStatusesText(agents: AgentStatus[]): string {
  if (agents.length === 0) return "👥 No agents";

  const lines: string[] = ["👥 Agents:"];
  for (const agent of agents) {
    const icon = agent.status === "busy" ? "🔴" : "🟢";
    const tasks = agent.currentTasks.length
      ? ` → ${agent.currentTasks.map(id => `#${id}`).join(", ")}`
      : "";
    lines.push(`  ${icon} ${agent.name}${tasks}`);
  }
  return lines.join("\n");
}

// ============================================================================
// Task Event Rendering (for notifications)
// ============================================================================

/**
 * Render a task notification as a human-readable message.
 * Used by mailbox system and lead poller for structured display.
 */
export function renderTaskEvent(notification: TaskNotification, theme: Theme): string {
  switch (notification.type) {
    case "task_assigned":
      return `${theme.fg("accent", "📋")} Task #${notification.taskId} (${notification.subject}) assigned by ${notification.assignedBy}`;

    case "task_unblocked":
      return `${theme.fg("success", "🔓")} Task #${notification.taskId} unblocked (dependency #${notification.unblockedBy} completed)`;

    case "task_completed":
      return `${theme.fg("success", "✅")} Task #${notification.taskId} completed by ${notification.completedBy}`;

    case "task_failed":
      return `${theme.fg("error", "❌")} Task #${notification.taskId} failed${notification.reason ? `: ${notification.reason}` : ""}`;

    case "verification_nudge":
      return `${theme.fg("warning", "⚠️")} ${notification.message}`;

    default:
      return `📋 Task event: ${JSON.stringify(notification)}`;
  }
}

/**
 * Render a task notification as plain text (no theme).
 */
export function renderTaskEventText(notification: TaskNotification): string {
  switch (notification.type) {
    case "task_assigned":
      return `📋 Task #${notification.taskId} (${notification.subject}) assigned by ${notification.assignedBy}`;
    case "task_unblocked":
      return `🔓 Task #${notification.taskId} unblocked (dependency #${notification.unblockedBy} completed)`;
    case "task_completed":
      return `✅ Task #${notification.taskId} completed by ${notification.completedBy}`;
    case "task_failed":
      return `❌ Task #${notification.taskId} failed${notification.reason ? `: ${notification.reason}` : ""}`;
    case "verification_nudge":
      return `⚠️ ${notification.message}`;
    default:
      return `📋 Task event: ${JSON.stringify(notification)}`;
  }
}

// ============================================================================
// Progress Rendering
// ============================================================================

/**
 * Render an inline progress bar for a running task.
 * Compact format suitable for subagent result displays.
 *
 * Format: 🔄 3 turns | 5 tools | 12K tokens | 2m 30s
 */
export function renderProgressInline(progress: TaskProgress, theme: Theme): string {
  const elapsed = Date.now() - progress.startedAt;
  const elapsedSec = Math.round(elapsed / 1000);
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;
  const elapsedStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  const totalTokens = progress.tokenUsage.input + progress.tokenUsage.output;

  return theme.fg("dim",
    `🔄 ${progress.turnCount} turns | ${progress.toolUseCount} tools | ${formatTokenCount(totalTokens)} tokens | ${elapsedStr}`,
  );
}

/**
 * Render a progress summary with tool breakdown.
 * More detailed version for expanded task views.
 */
export function renderProgressDetail(progress: TaskProgress, theme: Theme): Container {
  const container = new Container();

  const elapsed = Date.now() - progress.startedAt;
  const elapsedSec = Math.round(elapsed / 1000);
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;
  const elapsedStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  const totalTokens = progress.tokenUsage.input + progress.tokenUsage.output;

  // Main progress line
  container.addChild(new Text(
    theme.fg("dim",
      `📊 ${progress.turnCount} turns | ${progress.toolUseCount} tools | ${formatTokenCount(totalTokens)} tokens | ${elapsedStr}`,
    ),
    0, 0,
  ));

  // Tools used
  if (progress.toolsUsed.length > 0) {
    const toolStr = progress.toolsUsed.slice(0, 8).join(", ") +
      (progress.toolsUsed.length > 8 ? ` +${progress.toolsUsed.length - 8}` : "");
    container.addChild(new Text(theme.fg("dim", `🔧 ${toolStr}`), 0, 0));
  }

  // Last 3 activities
  const recent = progress.activities.slice(-3);
  for (const a of recent) {
    const icon = { tool_use: "🔧", message: "💬", status_change: "🔄", error: "⚠️" }[a.type];
    container.addChild(new Text(theme.fg("dim", `  ${icon} ${a.detail}`), 0, 0));
  }

  return container;
}

// ============================================================================
// Dashboard Rendering
// ============================================================================

/**
 * Render the full task dashboard (combined task list + agent status).
 * Used by the task_list tool and /tasks command.
 */
export function renderDashboard(
  tasks: TaskItem[],
  agents: AgentStatus[],
  theme: Theme,
  teamName?: string,
): Container {
  const container = new Container();

  // Task list
  container.addChild(renderTaskList(tasks, theme, teamName));

  // Separator
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", "─".repeat(40)), 0, 0));
  container.addChild(new Spacer(1));

  // Agent statuses
  container.addChild(renderAgentStatuses(agents, theme));

  // Summary stats
  const stats = computeTaskStats(tasks);
  container.addChild(new Spacer(1));
  container.addChild(new Text(
    theme.fg("dim",
      `Total: ${stats.total} | ✅ ${stats.completed} | 🔄 ${stats.inProgress} | ⏳ ${stats.pending} | ❌ ${stats.failed}`,
    ),
    0, 0,
  ));

  return container;
}

/**
 * Render the dashboard as plain text.
 */
export function renderDashboardText(
  tasks: TaskItem[],
  agents: AgentStatus[],
  teamName?: string,
): string {
  const parts: string[] = [];

  parts.push(renderTaskListText(tasks, teamName));
  parts.push("");
  parts.push(renderAgentStatusesText(agents));

  const stats = computeTaskStats(tasks);
  parts.push("");
  parts.push(`Total: ${stats.total} | ✅ ${stats.completed} | 🔄 ${stats.inProgress} | ⏳ ${stats.pending} | ❌ ${stats.failed}`);

  return parts.join("\n");
}

// ============================================================================
// Subagent Result Integration
// ============================================================================

/**
 * Render a status badge for a subagent's associated task.
 * Shows the task status inline in the subagent tool result.
 *
 * Used by render.ts:renderSubagentResult to show task context.
 */
export function renderTaskBadge(task: TaskItem | null, theme: Theme): string {
  if (!task) return "";
  const icon = STATUS_ICON[task.status];
  const colorKey = statusColorKey(task.status);
  return `${icon} ${theme.fg(colorKey, `#${task.id}: ${task.subject}`)}`;
}

// ============================================================================
// Internal Helpers
// ============================================================================

function statusLabel(status: TaskStatus): string {
  switch (status) {
    case "pending": return "Pending";
    case "in_progress": return "In Progress";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "killed": return "Killed";
  }
}

interface TaskStats {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  killed: number;
}

function computeTaskStats(tasks: TaskItem[]): TaskStats {
  return {
    total: tasks.length,
    pending: tasks.filter(t => t.status === "pending").length,
    inProgress: tasks.filter(t => t.status === "in_progress").length,
    completed: tasks.filter(t => t.status === "completed").length,
    failed: tasks.filter(t => t.status === "failed").length,
    killed: tasks.filter(t => t.status === "killed").length,
  };
}
