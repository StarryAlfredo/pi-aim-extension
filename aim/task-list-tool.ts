/**
 * AIM — TaskList Tool (P5)
 *
 * LLM-facing tool for listing and filtering tasks in the active team.
 * Includes agent status snapshot for workload awareness.
 *
 * Mirrors Claude Code's task list display:
 *   - Tasks with status icons and owner info
 *   - Dependency indicators (blockedBy)
 *   - Progress summaries for in-progress tasks
 *   - Agent status overview (who's busy / idle)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import { listTasks, isTerminalStatus } from "./shared-tasks.js";
import { getActiveTeam } from "./teams.js";
import { getTeamStatusSnapshot, formatAgentStatuses, type AgentStatus } from "./agent-status.js";
import { getProgressTracker, generateCompactSummary } from "./task-progress.js";
// P8: Dashboard rendering
import { renderDashboardText, renderTaskListText, renderAgentStatusesText } from "./task-render.js";
import type { TaskItem, TaskStatus } from "./types.js";

// ============================================================================
// Schema
// ============================================================================

const TaskListParams = Type.Object({
  status_filter: Type.Optional(Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("killed"),
  ], { description: "Only show tasks with this status" })),
  owner_filter: Type.Optional(Type.String({ description: "Only show tasks owned by this agent" })),
});

// ============================================================================
// Registration
// ============================================================================

export function registerTaskListTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "task_list",
    label: "TaskList",
    description: [
      "List all tasks in the active team, with optional filtering.",
      "Includes agent status (who's busy/idle) and progress summaries.",
      "Use status_filter or owner_filter to narrow results.",
    ].join(" "),
    promptSnippet: "Check the team's task list and agent workload",
    promptGuidelines: [
      "Check task_list before creating new tasks to avoid duplicates.",
      "Use owner_filter to see your own tasks.",
      "Use status_filter='in_progress' to see active work.",
    ],
    parameters: TaskListParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const team = getActiveTeam(ctx.cwd);
      if (!team) {
        return {
          content: [{ type: "text", text: "No active team. Create a team first with team_create." }],
          isError: true,
        };
      }

      // Fetch all tasks
      let tasks = listTasks(ctx.cwd, team);

      // Apply filters
      if (params.status_filter) {
        tasks = tasks.filter(t => t.status === params.status_filter);
      }
      if (params.owner_filter) {
        tasks = tasks.filter(t => t.owner === params.owner_filter);
      }

      // Build dashboard display (P8: using centralized rendering)
      let displayText: string;

      if (tasks.length === 0) {
        if (params.status_filter || params.owner_filter) {
          displayText = "📋 No tasks found matching filters. (Try without filters to see all tasks)";
        } else {
          displayText = "📋 No tasks found.";
        }
      } else {
        // Use P8 dashboard rendering for full display
        try {
          const snapshot = getTeamStatusSnapshot(ctx.cwd, team);
          displayText = renderDashboardText(tasks, snapshot, team);
        } catch {
          // Fallback to simple task list if agent status unavailable
          displayText = renderTaskListText(tasks, team);
        }
      }

      // Summary stats (always show for the full team, not filtered)
      const allTasks = listTasks(ctx.cwd, team);
      const stats = {
        total: allTasks.length,
        pending: allTasks.filter(t => t.status === "pending").length,
        in_progress: allTasks.filter(t => t.status === "in_progress").length,
        completed: allTasks.filter(t => t.status === "completed").length,
        failed: allTasks.filter(t => t.status === "failed").length,
        killed: allTasks.filter(t => t.status === "killed").length,
      };

      // Add filter info if filtered results differ from full list
      if (params.status_filter || params.owner_filter) {
        displayText += `\n\n(Filter: ${[params.status_filter, params.owner_filter].filter(Boolean).join(", ")} — showing ${tasks.length} of ${stats.total} tasks)`;
      }

      return {
        content: [{ type: "text", text: displayText }],
        details: { tasks, stats },
      };
    },

    renderCall(args, theme) {
      const filters: string[] = [];
      if (args.status_filter) filters.push(args.status_filter);
      if (args.owner_filter) filters.push(args.owner_filter);
      const filterStr = filters.length ? theme.fg("dim", ` [${filters.join(", ")}]`) : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("task_list")) + filterStr,
        0, 0,
      );
    },

    renderResult(result, _opts, theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });
}
