/**
 * AIM — TaskOutput Tool (P5)
 *
 * LLM-facing tool for reading task output and progress.
 * Supports both blocking (wait for completion) and non-blocking modes.
 *
 * Mirrors Claude Code's TaskOutputTool:
 *   - Non-blocking: returns current status + progress summary
 *   - Blocking: polls until terminal state, then returns final output
 *   - For completed agents: reads transcript for full output
 *   - Timeout protection: max 5 minutes for blocking waits
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import { getTask, isTerminalStatus } from "./shared-tasks.js";
import { getActiveTeam } from "./teams.js";
import { getProgressTracker, generateProgressSummary, generateCompactSummary } from "./task-progress.js";
import { readAgentMetadata, readTranscript } from "./aim-transcript.js";
import { getFinalOutput } from "./render.js";
// P7: Result storage
import { readPersistedResult, isResultPersisted, getPersistedResultPath, PER_AGENT_INLINE_LIMIT } from "./task-result-storage.js";
import type { TaskItem } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

/** Maximum wait time for blocking mode (5 minutes) */
const MAX_WAIT_MS = 300_000;

/** Poll interval for blocking mode */
const POLL_INTERVAL_MS = 500;

// ============================================================================
// Schema
// ============================================================================

const TaskOutputParams = Type.Object({
  task_id: Type.String({ description: "ID of the task to check" }),
  wait: Type.Optional(Type.Boolean({
    description: "Block until the task reaches a terminal state (default: false)",
    default: false,
  })),
});

// ============================================================================
// Registration
// ============================================================================

export function registerTaskOutputTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "task_output",
    label: "TaskOutput",
    description: [
      "Read the output and progress of a task.",
      "Non-blocking (default): returns current status and progress summary.",
      "Blocking (wait=true): polls until the task completes, fails, or is killed.",
      "For completed agent tasks, reads the full transcript output.",
    ].join(" "),
    promptSnippet: "Check task output or wait for completion",
    promptGuidelines: [
      "Use wait=true when you need the result before proceeding.",
      "Use wait=false for quick status checks on background tasks.",
      "Completed tasks include full transcript output when available.",
    ],
    parameters: TaskOutputParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const team = getActiveTeam(ctx.cwd);
      if (!team) {
        return {
          content: [{ type: "text", text: "No active team. Create a team first with team_create." }],
          isError: true,
        };
      }

      const taskId = params.task_id;

      // --- Initial check ---
      let task = getTask(ctx.cwd, team, taskId);
      if (!task) {
        return {
          content: [{ type: "text", text: `❌ Task #${taskId} not found.` }],
          isError: true,
        };
      }

      const startTime = Date.now();

      // --- Blocking mode: wait for terminal state ---
      if (params.wait && !isTerminalStatus(task.status)) {

        await new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            // Check abort signal
            if (signal?.aborted) {
              clearInterval(interval);
              resolve();
              return;
            }

            // Check timeout
            if (Date.now() - startTime > MAX_WAIT_MS) {
              clearInterval(interval);
              resolve();
              return;
            }

            // Poll task status
            const current = getTask(ctx.cwd, team, taskId);
            if (!current || isTerminalStatus(current.status)) {
              clearInterval(interval);
              resolve();
            }
          }, POLL_INTERVAL_MS);
        });

        task = getTask(ctx.cwd, team, taskId) ?? task;
      }

      // Check if we timed out while waiting
      const timedOut = params.wait && !isTerminalStatus(task.status) && (Date.now() - startTime > MAX_WAIT_MS - 1000);

      // --- Build response ---
      const lines: string[] = [];
      const statusIcon: Record<string, string> = {
        pending: "⏳", in_progress: "🔄", completed: "✅", failed: "❌", killed: "💀",
      };
      const icon = statusIcon[task.status] ?? "?";

      lines.push(`${icon} Task #${task.id}: ${task.subject}`);
      lines.push(`   Status: ${task.status} | Owner: ${task.owner ?? "unassigned"}`);
      lines.push(`   Type: ${task.type} | Created: ${new Date(task.createdAt).toLocaleTimeString()}`);

      if (timedOut) {
        lines.push("");
        lines.push("⚠️ Timed out waiting for task to complete (5 min). Task may still be running.");
      }

      // Progress info
      const progress = getProgressTracker(taskId);
      if (progress) {
        lines.push("");
        lines.push(generateProgressSummary(taskId));
      } else {
        const compactProgress = generateCompactSummary(taskId);
        if (compactProgress !== "(no progress)") {
          lines.push(`   Progress: ${compactProgress}`);
        }
      }

      // For completed agent tasks, try to read output
      // P7: Priority: persisted result file > transcript
      if (isTerminalStatus(task.status)) {
        lines.push("");

        // P7: Try persisted result file first (from task-result-storage.ts)
        const possibleAgentIds = [task.metadata?.agentId, task.owner, taskId].filter(Boolean) as string[];
        let outputFound = false;

        for (const agentId of possibleAgentIds) {
          // Check if there's a persisted result file from P7 overflow handling
          if (isResultPersisted(ctx.cwd, agentId)) {
            const fullOutput = readPersistedResult(ctx.cwd, agentId);
            if (fullOutput) {
              const MAX_INLINE = 50_000;
              if (fullOutput.length > MAX_INLINE) {
                lines.push(`📄 Output (${fullOutput.length.toLocaleString()} chars):`);
                lines.push(fullOutput.slice(0, MAX_INLINE));
                lines.push(`\n... (truncated. Full output: ${getPersistedResultPath(ctx.cwd, agentId)})`);
              } else {
                lines.push("📄 Output:");
                lines.push(fullOutput);
              }
              outputFound = true;
              break;
            }
          }
        }

        // Fallback: try to read from agent transcript (existing behavior)
        if (!outputFound) {
          for (const agentId of possibleAgentIds) {
            const meta = readAgentMetadata(ctx.cwd, agentId);
            if (meta) {
              const transcriptMsgs = readTranscript(ctx.cwd, agentId);
              if (transcriptMsgs.length > 0) {
                const output = getFinalOutput(transcriptMsgs);
                if (output) {
                  const MAX_INLINE = 50_000;
                  if (output.length > MAX_INLINE) {
                    lines.push(`📄 Output (${output.length.toLocaleString()} chars):`);
                    lines.push(output.slice(0, MAX_INLINE));
                    lines.push(`\n... (truncated. Full output in transcript: .pi/aim/agents/${agentId}.jsonl)`);
                  } else {
                    lines.push("📄 Output:");
                    lines.push(output);
                  }
                  outputFound = true;
                  break;
                }
              }
            }
          }
        }

        if (!outputFound && task.status === "completed") {
          lines.push("📄 Output: (no output captured)");
        }

        if (task.status === "failed" && task.metadata?.failureReason) {
          lines.push(`⚠️ Failure reason: ${task.metadata.failureReason}`);
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { task },
      };
    },

    renderCall(args, theme) {
      const wait = args.wait ? theme.fg("warning", " (waiting)") : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("task_output ")) +
        theme.fg("accent", `#${args.task_id ?? "?"}`) +
        wait,
        0, 0,
      );
    },

    renderResult(result, _opts, theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";
      // Use dim styling for long outputs
      if (text.length > 2000) {
        return new Text(theme.fg("dim", text), 0, 0);
      }
      return new Text(text, 0, 0);
    },
  });
}
