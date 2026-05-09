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
import { listTasks, isTerminalStatus } from "./shared-tasks.js";
import { getActiveTeam } from "./teams.js";
import { getTeamStatusSnapshot, formatAgentStatuses } from "./agent-status.js";
import { getProgressTracker, generateCompactSummary } from "./task-progress.js";
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

      // Build task list display
      const lines: string[] = [];

      if (tasks.length === 0) {
        lines.push("📋 No tasks found.");
        if (params.status_filter || params.owner_filter) {
          lines.push("   (Try without filters to see all tasks)");
        }
      } else {
        lines.push(`📋 Tasks (${tasks.length}):`);
        lines.push("");

        for (const task of tasks) {
          const statusIcon: Record<string, string> = {
            pending: "⏳", in_progress: "🔄", completed: "✅", failed: "❌", killed: "💀",
          };
          const icon = statusIcon[task.status] ?? "?";

          const owner = task.owner ? ` (${task.owner})` : " (unassigned)";
          const typeTag = task.type !== "local_agent" ? ` [${task.type}]` : "";
          const blocked = task.blockedBy.length > 0
            ? ` [blocked by: ${task.blockedBy.map(id => `#${id}`).join(",")}]`
            : "";

          lines.push(`  ${icon} #${task.id}: ${task.subject}${owner}${typeTag}${blocked}`);

          // Progress for active tasks
          if (task.status === "in_progress") {
            const progress = getProgressTracker(task.id);
            if (progress) {
              lines.push(`     📊 ${generateCompactSummary(task.id)}`);
            }
          }

          // Active form
          if (task.activeForm) {
            lines.push(`     → ${task.activeForm}`);
          }
        }
      }

      // Agent status snapshot
      lines.push("");
      try {
        const snapshot = getTeamStatusSnapshot(ctx.cwd, team);
        lines.push(formatAgentStatuses(snapshot));
      } catch {
        lines.push("(Agent status unavailable)");
      }

      // Summary stats
      const allTasks = listTasks(ctx.cwd, team);
      const stats = {
        total: allTasks.length,
        pending: allTasks.filter(t => t.status === "pending").length,
        in_progress: allTasks.filter(t => t.status === "in_progress").length,
        completed: allTasks.filter(t => t.status === "completed").length,
        failed: allTasks.filter(t => t.status === "failed").length,
        killed: allTasks.filter(t => t.status === "killed").length,
      };

      lines.push("");
      lines.push(
        `📊 Total: ${stats.total} | ` +
        `⏳ ${stats.pending} pending | 🔄 ${stats.in_progress} active | ` +
        `✅ ${stats.completed} done | ❌ ${stats.failed} failed | 💀 ${stats.killed} killed`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { tasks, stats },
      };
    },

    renderCall(args, theme) {
      const filters: string[] = [];
      if (args.status_filter) filters.push(args.status_filter);
      if (args.owner_filter) filters.push(args.owner_filter);
      const filterStr = filters.length ? theme.fg("dim", ` [${filters.join(", ")}]`) : "";
      return new (require("@mariozechner/pi-tui").Text)(
        theme.fg("toolTitle", theme.bold("task_list")) + filterStr,
        0, 0,
      );
    },

    renderResult(result, _opts, theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";
      return new (require("@mariozechner/pi-tui").Text)(theme.fg("dim", text), 0, 0);
    },
  });
}
