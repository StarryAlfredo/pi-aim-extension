/**
 * AIM — Multi-Agent Orchestration
 *
 * Core extension providing multi-agent capabilities to pi coding agent.
 * Gives LLM the ability to spawn, coordinate, and communicate with child agents.
 *
 * ## Registered Tools
 *  - subagent: Spawn child agents (sync/async/fork/parallel/chain)
 *  - send_message: Inter-agent communication via inbox files
 *  - team_create / team_delete: Team management
 *
 * ## Registered Commands
 *  - /coordinator: Toggle coordinator mode
 *
 * ## Exported API (for other extensions)
 *  - workerPool, mailbox functions, team functions
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
import { registerTeams } from "./teams.js";
import { registerPermissions } from "./permissions.js";
import { getDisplayItems, getFinalOutput, formatToolCall, formatUsageStats, renderSubagentResult } from "./render.js";

// Re-export for other extensions
export { workerPool } from "./worker-pool.js";
export { readMailbox, writeToMailbox, markMessageAsRead, isShutdownRequest, isPermissionResponse, createShutdownRequest, createShutdownApproval, createShutdownRejection, createIdleNotification } from "./mailbox.js";
export { discoverAgents, formatAgentList } from "./agents.js";
export { createTeam, deleteTeam, spawnTeammate, getActiveTeam } from "./teams.js";
export { pollInbox, sendIdleNotification } from "./poller.js";
export type { WorkerConfig, WorkerInfo, AgentConfig, AgentScope, AgentDiscoveryResult, TeammateMessage, TeamFile, TeamMember, StructureMessage } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

// ============================================================================
// Concurrent mapping helper
// ============================================================================

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
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
// Subagent execution helpers
// ============================================================================

interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Awaited<ReturnType<typeof import("@mariozechner/pi-ai").Message>>[];
  stderr: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens: number; turns: number };
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

async function runSingleAgent(
  cwd: string,
  agents: AgentConfig[],
  config: { agent: string; task: string; fork?: boolean; background?: boolean; cwd?: string; model?: string; tools?: string[]; systemPrompt?: string },
  signal: AbortSignal | undefined,
  onUpdate: ((partial: { agent: string; status: string; output: string }) => void) | undefined,
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === config.agent);

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: config.agent,
      agentSource: "unknown",
      task: config.task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${config.agent}". Available agents: ${available}.`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    };
  }

  const forkFrom = config.fork ? undefined : undefined; // TODO: pass parent session path

  const workerId = workerPool.spawn({
    name: config.agent,
    prompt: config.task,
    model: config.model ?? agent.model,
    tools: config.tools ?? agent.tools,
    cwd: config.cwd ?? cwd,
    background: config.background ?? false,
    forkFrom,
    systemPrompt: config.systemPrompt ?? agent.systemPrompt,
  });

  const info = workerPool.getInfo(workerId);
  if (!info) throw new Error("Worker spawn failed");

  // Report initial status
  onUpdate?.({ agent: config.agent, status: "running", output: "" });

  // If background, fire-and-forget
  if (config.background) {
    return {
      agent: config.agent,
      agentSource: agent.source,
      task: config.task,
      exitCode: -1, // not yet complete
      messages: [],
      stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    };
  }

  // Sync: wait for completion
  try {
    const result = await workerPool.waitFor(workerId);

    let input_tokens = 0, output_tokens = 0, cache_read = 0, cache_write = 0, cost = 0, context_tokens = 0, turns = 0;
    let model: string | undefined;
    let stopReason: string | undefined;
    let errorMessage: string | undefined;

    for (const msg of result.messages) {
      if (msg.role === "assistant") {
        turns++;
        const usage = (msg as Record<string, unknown>).usage as Record<string, number> | undefined;
        if (usage) {
          input_tokens += usage.input || 0;
          output_tokens += usage.output || 0;
          cache_read += usage.cacheRead || 0;
          cache_write += usage.cacheWrite || 0;
          cost += usage.cost || 0;
          context_tokens = usage.totalTokens || 0;
        }
        if ((msg as Record<string, unknown>).model) model = (msg as Record<string, unknown>).model as string;
        stopReason = (msg as Record<string, unknown>).stopReason as string | undefined;
        errorMessage = (msg as Record<string, unknown>).errorMessage as string | undefined;
      }
    }

    onUpdate?.({ agent: config.agent, status: result.exitCode === 0 ? "completed" : "error", output: getFinalOutput(result.messages) });

    return {
      agent: config.agent,
      agentSource: agent.source,
      task: config.task,
      exitCode: result.exitCode ?? 1,
      messages: result.messages,
      stderr: result.stderr,
      usage: { input: input_tokens, output: output_tokens, cacheRead: cache_read, cacheWrite: cache_write, cost, contextTokens: context_tokens, turns },
      model,
      stopReason,
      errorMessage,
    };
  } catch (err) {
    return {
      agent: config.agent,
      agentSource: agent.source,
      task: config.task,
      exitCode: 1,
      messages: [],
      stderr: err instanceof Error ? err.message : String(err),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    };
  }
}

// ============================================================================
// Subagent Tool
// ============================================================================

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
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
  description: 'Agent directories to use. Default: "user". Use "both" to include project-local agents.',
  default: "user",
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array for parallel execution" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Array for sequential execution" })),
  agentScope: Type.Optional(AgentScopeSchema),
  fork: Type.Optional(Type.Boolean({ description: "Fork the current session (inherit context). Default: false", default: false })),
  background: Type.Optional(Type.Boolean({ description: "Run in background. Default: false", default: false })),
  model: Type.Optional(Type.String({ description: "Model override for single mode" })),
  team_name: Type.Optional(Type.String({ description: "Team name for spawning as teammate" })),
  teammate_name: Type.Optional(Type.String({ description: "Name for the spawned teammate" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

// ============================================================================
// Extension Entry
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Register subagent tool
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents with isolated context windows.",
      "Modes: single (agent+task), parallel (tasks array), chain (sequential with {previous} placeholder).",
      'Default agent scope is "user" (from ~/.pi/agent/agents).',
      'To enable project-local agents in .pi/agents, set agentScope: "both".',
      "Use fork:true to inherit the current session context.",
      "Use background:true to fire-and-forget (result via notification).",
    ].join(" "),
    promptSnippet: "Spawn a subagent to handle complex, multi-step tasks autonomously",
    promptGuidelines: [
      "Use subagent when tasks are complex, multi-step, or benefit from isolated context.",
      "Run independent subagents in parallel (tasks array) to maximize throughput.",
      "Use chain mode with {previous} for sequential dependency workflows.",
      "Prefer fork:true for research tasks to inherit current session context.",
      "Use background:true for long-running tasks that don't block your next steps.",
      "After launching background agents, briefly tell the user and continue — results arrive via notification.",
    ],
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope: AgentScope = params.agentScope ?? "user";
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      if (modeCount !== 1) {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return {
          content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` }],
          details: { mode: "invalid", reason: "ambiguous mode" },
        };
      }

      // --- Team spawn path ---
      if (params.team_name) {
        const { spawnTeammate } = await import("./teams.js");
        const result = await spawnTeammate(ctx.cwd, {
          name: params.teammate_name ?? params.agent ?? "teammate",
          prompt: params.task ?? "",
          team_name: params.team_name,
          agent_type: params.agent,
          model: params.model,
          plan_mode_required: false,
        }, agents);

        return {
          content: [{
            type: "text",
            text: `Teammate "${result.name}" spawned in team "${result.team}". Agent ID: ${result.agentId}`,
          }],
          details: { mode: "teammate_spawned", ...result },
        };
      }

      // --- Chain mode ---
      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        let previousOutput = "";

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

          const result = await runSingleAgent(ctx.cwd, agents, {
            agent: step.agent,
            task: taskWithContext,
            cwd: step.cwd,
            model: step.model,
          }, signal, (update) => {
            onUpdate?.({
              content: [{ type: "text", text: `[${i + 1}/${params.chain!.length}] ${update.agent}: ${update.status}` }],
              details: { mode: "chain", step: i + 1, total: params.chain!.length, ...update },
            });
          });

          results.push(result);
          const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
          if (isError) {
            const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
            return {
              content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
              details: { mode: "chain", results, error: true, failedAt: i + 1 },
              isError: true,
            };
          }
          previousOutput = getFinalOutput(result.messages);
        }
        return {
          content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
          details: { mode: "chain", results },
        };
      }

      // --- Parallel mode ---
      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          return {
            content: [{ type: "text", text: `Too many tasks (${params.tasks.length}). Max: ${MAX_PARALLEL_TASKS}` }],
            details: { mode: "parallel", error: true, reason: "too_many_tasks" },
          };
        }

        const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, _index) => {
          return runSingleAgent(ctx.cwd, agents, {
            agent: t.agent,
            task: t.task,
            cwd: t.cwd,
            model: t.model,
            tools: t.tools,
          }, signal, (update) => {
            onUpdate?.({ content: [{ type: "text", text: `[parallel] ${update.agent}: ${update.status}` }], details: { mode: "parallel", ...update } });
          });
        });

        const successCount = results.filter((r) => r.exitCode === 0).length;
        const summaries = results.map((r) => {
          const output = getFinalOutput(r.messages);
          const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
          return `[${r.agent}] ${r.exitCode === 0 ? "✓" : "✗"}: ${preview || "(no output)"}`;
        });

        return {
          content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}` }],
          details: { mode: "parallel", results },
        };
      }

      // --- Single mode ---
      if (params.agent && params.task) {
        const result = await runSingleAgent(ctx.cwd, agents, {
          agent: params.agent,
          task: params.task,
          fork: params.fork,
          background: params.background,
          cwd: params.cwd,
          model: params.model,
        }, signal, (update) => {
          onUpdate?.({ content: [{ type: "text", text: `${update.agent}: ${update.status}` }], details: { mode: "single", ...update } });
        });

        if (params.background) {
          return {
            content: [{
              type: "text",
              text: `Background agent "${params.agent}" launched. Results will arrive via notification. Worker ID: ${workerPool.getInfo(agent ? result.agent : "")} ${/* placeholder */ ""}`,
            }],
            details: { mode: "single", background: true },
          };
        }

        const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
        if (isError) {
          const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
          return {
            content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
            details: { mode: "single", ...result },
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
          details: { mode: "single", result },
        };
      }

      const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
      return {
        content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
        details: { mode: "invalid" },
      };
    },

    renderCall(args, theme, _context) {
      const scope: AgentScope = args.agentScope ?? "user";
      if (args.chain && args.chain.length > 0) {
        let text = theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `chain (${args.chain.length} steps)`) +
          theme.fg("muted", ` [${scope}]`);
        for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
          const step = args.chain[i];
          const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
          const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
          text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview}`)}`;
        }
        if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      if (args.tasks && args.tasks.length > 0) {
        let text = theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
          theme.fg("muted", ` [${scope}]`);
        for (const t of args.tasks.slice(0, 3)) {
          const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
          text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
        }
        if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      const agentName = args.agent ?? "...";
      const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
      let text = theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("accent", agentName) +
        theme.fg("muted", ` [${scope}]`);
      text += `\n  ${theme.fg("dim", preview)}`;
      if (args.fork) text += ` ${theme.fg("warning", "(fork)")}`;
      if (args.background) text += ` ${theme.fg("warning", "(background)")}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as Record<string, unknown> | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const mdTheme = getMarkdownTheme();

      // Single mode
      if (details.mode === "single") {
        const r = details.result as SingleResult | undefined;
        if (r) {
          return renderSubagentResult(result, expanded, theme, r.agent, r.agentSource, r.task, r.model, r.usage, r.stopReason, r.errorMessage);
        }
      }

      // Chain mode
      if (details.mode === "chain") {
        const results = (details.results ?? []) as SingleResult[];
        const successCount = results.filter((r) => r.exitCode === 0).length;
        const icon = successCount === results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

        if (expanded) {
          const container = new Container();
          container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${results.length} steps`)}`, 0, 0));
          for (const r of results) {
            const ri = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
            const items = getDisplayItems(r.messages);
            const output = getFinalOutput(r.messages);
            container.addChild(new Spacer(1));
            container.addChild(new Text(`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${ri}`, 0, 0));
            container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
            for (const item of items) {
              if (item.type === "toolCall") container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args as Record<string, unknown>, theme), 0, 0));
            }
            if (output) { container.addChild(new Spacer(1)); container.addChild(new Markdown(output.trim(), 0, 0, mdTheme)); }
            const usageStr = formatUsageStats(r.usage, r.model);
            if (usageStr) container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
          }
          const totalUsage = { input: results.reduce((s, r) => s + r.usage.input, 0), output: results.reduce((s, r) => s + r.usage.output, 0), cacheRead: results.reduce((s, r) => s + r.usage.cacheRead, 0), cacheWrite: results.reduce((s, r) => s + r.usage.cacheWrite, 0), cost: results.reduce((s, r) => s + r.usage.cost, 0), turns: results.reduce((s, r) => s + r.usage.turns, 0) };
          const totalStr = formatUsageStats(totalUsage);
          if (totalStr) { container.addChild(new Spacer(1)); container.addChild(new Text(theme.fg("dim", `Total: ${totalStr}`), 0, 0)); }
          return container;
        }
        let text = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${results.length} steps`)}`;
        for (const r of results) {
          const ri = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
          const items = getDisplayItems(r.messages);
          text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${ri}`;
          text += items.length === 0 ? `\n${theme.fg("muted", "(no output)")}` : `\n${items.slice(-5).map((i) => i.type === "text" ? theme.fg("toolOutput", i.text) : theme.fg("muted", "→ ") + formatToolCall(i.name, i.args as Record<string, unknown>, theme)).join("\n")}`;
        }
        return new Text(text, 0, 0);
      }

      // Parallel mode
      if (details.mode === "parallel") {
        const results = (details.results ?? []) as SingleResult[];
        const running = results.filter((r) => r.exitCode === -1).length;
        const successCount = results.filter((r) => r.exitCode === 0).length;
        const failCount = results.filter((r) => r.exitCode > 0).length;
        const icon = running > 0 ? theme.fg("warning", "⏳") : failCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
        const status = running > 0 ? `${successCount + failCount}/${results.length} done, ${running} running` : `${successCount}/${results.length} tasks`;
        let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
        for (const r of results) {
          const ri = r.exitCode === -1 ? theme.fg("warning", "⏳") : r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
          const items = getDisplayItems(r.messages);
          text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${ri}`;
          text += items.length === 0 ? `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}` : `\n${items.slice(-5).map((i) => i.type === "text" ? theme.fg("toolOutput", i.text) : theme.fg("muted", "→ ") + formatToolCall(i.name, i.args as Record<string, unknown>, theme)).join("\n")}`;
        }
        if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      const content = result.content[0];
      return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
    },
  });

  // Register other AIM subsystems
  registerSendMessage(pi);
  registerCoordinator(pi);
  registerTeams(pi);
  registerPermissions(pi);
}