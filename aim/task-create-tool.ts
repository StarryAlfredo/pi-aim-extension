/**
 * AIM — TaskCreate Tool (P5)
 *
 * LLM-facing tool for creating tasks in the shared task list.
 * Requires an active team (uses getActiveTeam).
 *
 * Mirrors Claude Code's TaskCreateTool:
 *   - Validates input via TypeBox schema
 *   - Calls createTask() with full option support
 *   - Returns the created task on success
 *   - Hook vetos and missing-team errors are surfaced to the LLM
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import { createTask, type CreateTaskOptions } from "./shared-tasks.js";
import { getActiveTeam } from "./teams.js";
import { type TaskType } from "./types.js";

// ============================================================================
// Schema
// ============================================================================

const TaskCreateParams = Type.Object({
  subject: Type.String({ description: "Brief task title" }),
  description: Type.Optional(Type.String({ description: "Detailed task description" })),
  type: Type.Optional(Type.Union([
    Type.Literal("local_agent"),
    Type.Literal("in_process_teammate"),
    Type.Literal("local_bash"),
    Type.Literal("local_workflow"),
    Type.Literal("monitor"),
    Type.Literal("dream"),
  ], { description: "Task type (default: local_agent)" })),
  blockedBy: Type.Optional(Type.Array(Type.String(), { description: "IDs of tasks that must complete before this one" })),
  activeForm: Type.Optional(Type.String({ description: 'Present-tense display text (e.g. "Running tests")' })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arbitrary metadata for extensibility" })),
});

// ============================================================================
// Registration
// ============================================================================

export function registerTaskCreateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "task_create",
    label: "TaskCreate",
    description: [
      "Create a new task in the team's shared task list.",
      "Tasks can depend on other tasks via blockedBy.",
      "Requires an active team (use team_create first).",
    ].join(" "),
    promptSnippet: "Create a task to track work in the team",
    promptGuidelines: [
      "Create tasks for each unit of work that needs tracking.",
      "Use blockedBy to express dependencies between tasks.",
      "Set type to local_workflow for chain-style tasks, local_bash for shell commands.",
    ],
    parameters: TaskCreateParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const team = getActiveTeam();
      if (!team) {
        return {
          content: [{ type: "text", text: "No active team. Create a team first with team_create." }],
          isError: true,
        };
      }

      try {
        const options: CreateTaskOptions = {
          type: params.type as TaskType | undefined,
          activeForm: params.activeForm,
          blockedBy: params.blockedBy,
          metadata: params.metadata as Record<string, unknown> | undefined,
        };

        const task = await createTask(
          ctx.cwd,
          team.name,
          params.subject,
          params.description ?? "",
          options,
        );

        return {
          content: [{
            type: "text",
            text: [
              `✅ Task #${task.id} created: ${task.subject}`,
              `   Status: ${task.status} | Type: ${task.type}`,
              task.blockedBy.length > 0
                ? `   Blocked by: ${task.blockedBy.map(id => `#${id}`).join(", ")}`
                : "",
              task.activeForm
                ? `   Active form: ${task.activeForm}`
                : "",
            ].filter(Boolean).join("\n"),
          }],
          details: { task },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `❌ Failed to create task: ${message}` }],
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("task_create ")) +
        theme.fg("accent", args.subject ?? "...") +
        (args.type ? theme.fg("dim", ` [${args.type}]`) : ""),
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
