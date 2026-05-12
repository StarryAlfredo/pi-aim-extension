/**
 * AIM — Task Resume Tool
 *
 * LLM-callable tool for resuming interrupted tasks.
 * Extracted from index.ts. Uses task-resume.ts for the actual resume logic.
 *
 * Note: This tool does NOT use executeAgent() because task resume operates
 * at the task-system level — it updates task status and re-spawns workers
 * via task-resume.ts, not through the agent execution pipeline.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";

import { resumeTask, findOrphanTasks, recoverOrphanTasks, type ResumeResult, type OrphanTask } from "./task-resume.js";
import { getActiveTeam } from "./teams.js";

// ============================================================================
// Registration
// ============================================================================

export function registerTaskResumeTool(pi: ExtensionAPI): void {
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
      const team = getActiveTeam();
      if (!team) {
        return {
          content: [{ type: "text", text: "No active team. Create a team first with team_create." }],
          isError: true,
        };
      }
      const teamName = team.name;

      // --- Orphan recovery mode ---
      if (params.orphan_recovery) {
        const result = await recoverOrphanTasks(ctx.cwd, teamName, {
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

      const result = await resumeTask(ctx.cwd, teamName, params.task_id, { signal });

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
}
