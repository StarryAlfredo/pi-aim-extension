/**
 * AIM — Subagent Tool
 *
 * LLM-callable tool for delegating tasks to specialized subagents.
 * Supports single, parallel, chain, resume, and team-spawn modes.
 *
 * Extracted from index.ts. Uses executeAgent() from agent-executor.ts
 * for all execution logic — this file only handles mode routing and
 * TUI rendering.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum, type Message } from "@earendil-works/pi-ai";
import { Container, Text, Markdown, Spacer } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";

import { workerPool } from "./worker-pool.js";
import { discoverAgents } from "./agents.js";
import type { AgentConfig, AgentScope } from "./types.js";
import { executeAgent, type ExecutionContext, type AgentExecutionResult } from "./agent-executor.js";
import { collectTotalUsage, formatResultError } from "./agent-result.js";
import { registerTeams, getActiveTeam } from "./teams.js";
import { getDisplayItems, formatToolCall, formatUsageStats, renderSubagentResult } from "./render.js";
import { getFinalOutput } from "./agent-result.js";
import { handleResultOverflow, handleBatchOverflow, formatBatchOverflowDisplay } from "./task-result-storage.js";

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

/** Adapt AgentUpdate callbacks to the tool's onUpdate format */
function adaptUpdate(
  onUpdate: ((update: any) => void) | undefined,
  mode: string,
  textPrefix = "",
  extraDetails?: Record<string, unknown>,
) {
  return (up: import("./agent-executor.js").AgentUpdate) => onUpdate?.({
    content: [{ type: "text", text: `${textPrefix}${up.agent}: ${up.status}` }],
    details: { mode, ...up, ...extraDetails },
  });
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
  task_id: Type.Optional(Type.String({ description: "Associate this subagent with a task in the team's task list (P6)" })),
});

// ============================================================================
// Registration
// ============================================================================

export function registerSubagentTool(pi: ExtensionAPI): void {
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

      const execCtx: ExecutionContext = { pi, cwd, agents, signal, onUpdate: undefined };

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
        const result = await executeAgent(
          { ...execCtx, onUpdate: adaptUpdate(onUpdate, "resume") },
          { agent: "resumed", task: params.task ?? "", background: params.background, model: params.model, resumeAgentId: params.resume },
        );

        if (params.background) {
          return {
            content: [{ type: "text", text: `Resumed agent ${params.resume} in background.` }],
            details: { mode: "resume", background: true, agentId: result.agentId },
          };
        }
        return {
          content: [{ type: "text", text: handleResultOverflow(cwd, result.agentId, result.output || "(no output)").display }],
          details: { mode: "resume", result },
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
        const results: AgentExecutionResult[] = [];
        let prev = "";
        for (let i = 0; i < params.chain.length; i++) {
          const s = params.chain[i];
          const result = await executeAgent(
            { ...execCtx, onUpdate: adaptUpdate(onUpdate, "chain", `[${i + 1}/${params.chain!.length}] `, { step: i + 1 }) },
            { agent: s.agent, task: s.task.replace(/\{previous\}/g, prev), cwd: s.cwd, model: s.model },
          );
          results.push(result);
          if (result.exitCode !== 0) {
            const err = formatResultError(result);
            const reason = result.stopReason || "exited with error";
            return { content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${s.agent}) — ${reason}: ${err}` }], details: { mode: "chain", results, error: true }, isError: true };
          }
          prev = result.output;
        }
        // Overflow for chain's final output
        const finalResult = results[results.length - 1]!;
        return { content: [{ type: "text", text: handleResultOverflow(cwd, finalResult.agentId, finalResult.output || "(no output)").display }], details: { mode: "chain", results } };
      }

      // --- Parallel ---
      if (params.tasks?.length) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          return { content: [{ type: "text", text: `Max ${MAX_PARALLEL_TASKS} tasks.` }], details: { mode: "parallel", error: true } };
        }
        const results = await mapWithConcurrencyLimit(params.tasks as any[], MAX_CONCURRENCY, async (t: any) =>
          executeAgent(
            { ...execCtx, onUpdate: adaptUpdate(onUpdate, "parallel", "[parallel] ") },
            { agent: t.agent, task: t.task, cwd: t.cwd, model: t.model, tools: t.tools },
          )
        );
        const ok = results.filter(r => r.exitCode === 0).length;

        // Batch overflow: check total budget across all results
        const batchItems = results.map(r => ({
          agentId: r.agentId,
          fullOutput: r.output,
          agentName: r.agentName,
          exitCode: r.exitCode,
        }));

        const batch = handleBatchOverflow(cwd, batchItems);
        const agentNames = results.map(r => r.agentName);
        const exitCodes = results.map(r => r.exitCode);
        const displayText = formatBatchOverflowDisplay(batch, agentNames, exitCodes, ok, results.length);

        return { content: [{ type: "text", text: displayText }], details: { mode: "parallel", results } };
      }

      // --- Single ---
      if (params.agent && params.task) {
        const result = await executeAgent(
          { ...execCtx, onUpdate: adaptUpdate(onUpdate, "single") },
          { agent: params.agent, task: params.task, fork: params.fork, background: params.background, cwd: params.cwd, model: params.model, taskId: params.task_id, teamName: getActiveTeam()?.name },
        );

        if (result.exitCode === -1) {
          return { content: [{ type: "text", text: `Background agent "${params.agent}" launched. Agent ID: ${result.agentId}. Use resume: to continue.` }], details: { mode: "single", background: true, agentId: result.agentId } };
        }
        if (result.exitCode !== 0) {
          const err = formatResultError(result);
          const reason = result.stopReason || "exited with error";
          return { content: [{ type: "text", text: `Agent ${reason}: ${err}` }], details: { mode: "single", result }, isError: true };
        }
        return { content: [{ type: "text", text: handleResultOverflow(cwd, result.agentId, result.output || "(no output)").display }], details: { mode: "single", result } };
      }

      return { content: [{ type: "text", text: `Invalid params. Available: ${agents.map(a => a.name).join(", ") || "none"}` }], details: { mode: "invalid" } };
    },

    // ========== RENDER ==========

    renderCall(args: any, theme: any, _context: any) {
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

    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any, _ctx: any) {
      const details = result.details as Record<string, unknown> | undefined;
      if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
      const mdTheme = getMarkdownTheme();

      if (details.mode === "single" || details.mode === "resume") {
        const r = details.result as AgentExecutionResult | undefined;
        if (r) return renderSubagentResult(result, expanded, theme, r.agentName, r.agentSource, r.task, r.model, r.usage, r.stopReason, r.errorMessage);
      }

      if (details.mode === "chain") {
        const results = (details.results ?? []) as AgentExecutionResult[];
        const ok = results.filter(r => r.exitCode === 0).length;
        const icon = ok === results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
        if (expanded) {
          const c = new Container();
          c.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${ok}/${results.length} steps`)}`, 0, 0));
          for (let i = 0; i < results.length; i++) {
            const r = results[i]!;
            const ri = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
            c.addChild(new Spacer(1));
            c.addChild(new Text(`${theme.fg("muted", `Step ${i + 1}:`)} ${theme.fg("accent", r.agentName)} ${ri}`, 0, 0));
            c.addChild(new Text(theme.fg("dim", r.task), 0, 0));
            for (const item of getDisplayItems(r.messages).filter(x => x.type === "toolCall")) {
              c.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args as Record<string, unknown>, theme), 0, 0));
            }
            const out = r.output; if (out) { c.addChild(new Spacer(1)); c.addChild(new Markdown(out.trim(), 0, 0, mdTheme)); }
            const u = formatUsageStats(r.usage, r.model); if (u) c.addChild(new Text(theme.fg("dim", u), 0, 0));
          }
          const totalU = formatUsageStats(collectTotalUsage(results));
          if (totalU) { c.addChild(new Spacer(1)); c.addChild(new Text(theme.fg("dim", `Total: ${totalU}`), 0, 0)); }
          return c;
        }
        let t = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${ok}/${results.length}`)}`;
        for (let i = 0; i < results.length; i++) {
          const r = results[i]!;
          const ri = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
          t += `\n${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", r.agentName)} ${ri}`;
          const items = getDisplayItems(r.messages).slice(-5);
          for (const i of items) t += `\n  ${i.type === "text" ? theme.fg("toolOutput", i.text) : theme.fg("muted", "→ ") + formatToolCall(i.name, i.args as Record<string, unknown>, theme)}`;
        }
        t += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(t, 0, 0);
      }

      if (details.mode === "parallel") {
        const results = (details.results ?? []) as AgentExecutionResult[];
        const running = results.filter(r => r.exitCode === -1).length;
        const ok = results.filter(r => r.exitCode === 0).length;
        const fail = results.filter(r => r.exitCode > 0).length;
        const icon = running > 0 ? theme.fg("warning", "⏳") : fail > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
        const st = running > 0 ? `${ok + fail}/${results.length} done, ${running} running` : `${ok}/${results.length}`;
        let t = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", st)}`;
        for (const r of results) {
          const ri = r.exitCode === -1 ? theme.fg("warning", "⏳") : r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
          t += `\n${theme.fg("accent", r.agentName)} ${ri}`;
          const items = getDisplayItems(r.messages).slice(-3);
          for (const i of items) t += `\n  ${i.type === "text" ? theme.fg("toolOutput", i.text) : theme.fg("muted", "→ ") + formatToolCall(i.name, i.args as Record<string, unknown>, theme)}`;
        }
        return new Text(t, 0, 0);
      }

      const content = result.content[0];
      return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
    },
  });
}
