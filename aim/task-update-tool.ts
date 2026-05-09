/**
 * AIM — TaskUpdate Tool (P5)
 *
 * LLM-facing tool for updating task status, owner, and other fields.
 * Enforces state machine transitions and terminal state protection.
 *
 * Mirrors Claude Code's TaskUpdateTool:
 *   - Validates status transitions via updateTask()
 *   - Hook vetos are surfaced to the LLM
 *   - Owner changes trigger assignment notifications
 *   - Terminal transitions trigger unblock/failure propagation
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import { updateTask } from "./shared-tasks.js";
import { getActiveTeam } from "./teams.js";
import { type TaskItem, type TaskStatus } from "./types.js";

// ============================================================================
// Schema
// ============================================================================

const TaskUpdateParams = Type.Object({
  task_id: Type.String({ description: "ID of the task to update" }),
  status: Type.Optional(Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("killed"),
  ], { description: "New status (must be a valid transition from current)" })),
  owner: Type.Optional(Type.String({ description: "Assign task to this agent" })),
  description: Type.Optional(Type.String({ description: "Update task description" })),
  activeForm: Type.Optional(Type.String({ description: "Update present-tense display text" })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Update metadata (merged with existing)" })),
});

// ============================================================================
// Registration
// ============================================================================

export function registerTaskUpdateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "task_update",
    label: "TaskUpdate",
    description: [
      "Update a task's status, owner, or other properties.",
      "Status transitions are validated: pending→in_progress→completed/failed/killed.",
      "Terminal states (completed/failed/killed) cannot be changed.",
      "Owner changes trigger assignment notifications via mailbox.",
    ].join(" "),
    promptSnippet: "Update a task's status or assign it to an agent",
    promptGuidelines: [
      "Mark tasks as in_progress when work begins.",
      "Mark tasks as completed when done, failed if unrecoverable, killed to cancel.",
      "Assign tasks to specific agents by setting owner.",
      "You cannot change a terminal (completed/failed/killed) task.",
    ],
    parameters: TaskUpdateParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const team = getActiveTeam();
      if (!team) {
        return {
          content: [{ type: "text", text: "No active team. Create a team first with team_create." }],
          isError: true,
        };
      }
      const teamName = team.name;

      // Build updates object — only include fields that were provided
      const updates: Partial<Pick<TaskItem, "status" | "owner" | "description" | "activeForm" | "metadata">> = {};
      if (params.status !== undefined) updates.status = params.status as TaskStatus;
      if (params.owner !== undefined) updates.owner = params.owner;
      if (params.description !== undefined) updates.description = params.description;
      if (params.activeForm !== undefined) updates.activeForm = params.activeForm;
      if (params.metadata !== undefined) updates.metadata = params.metadata as Record<string, unknown>;

      if (Object.keys(updates).length === 0) {
        return {
          content: [{ type: "text", text: "No updates provided. Specify at least one field to change." }],
          isError: true,
        };
      }

      try {
        const task = await updateTask(ctx.cwd, teamName, params.task_id, updates);

        if (!task) {
          return {
            content: [{ type: "text", text: `❌ Task #${params.task_id} not found.` }],
            isError: true,
          };
        }

        const statusIcon: Record<string, string> = {
          pending: "⏳", in_progress: "🔄", completed: "✅", failed: "❌", killed: "💀",
        };
        const icon = statusIcon[task.status] ?? "?";

        return {
          content: [{
            type: "text",
            text: [
              `${icon} Task #${task.id} updated: ${task.subject}`,
              `   Status: ${task.status} | Owner: ${task.owner ?? "unassigned"}`,
              task.activeForm ? `   Active: ${task.activeForm}` : "",
            ].filter(Boolean).join("\n"),
          }],
          details: { task },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `❌ Failed to update task #${params.task_id}: ${message}` }],
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      const parts: string[] = [];
      if (args.status) parts.push(`→ ${args.status}`);
      if (args.owner) parts.push(`→ ${args.owner}`);
      return new Text(
        theme.fg("toolTitle", theme.bold("task_update ")) +
        theme.fg("accent", `#${args.task_id ?? "?"}`) +
        (parts.length ? theme.fg("dim", ` ${parts.join(", ")}`) : ""),
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
