/**
 * AIM — Multi-Agent Orchestration
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
import {
  writeAgentMetadata, readAgentMetadata, readTranscript, appendToTranscript,
  recordSubagentSpawn, recordSubagentResult,
} from "./aim-transcript.js";

// Re-export for other extensions
export { workerPool } from "./worker-pool.js";
export { readMailbox, writeToMailbox, markMessageAsRead, isShutdownRequest, isPermissionResponse, createShutdownRequest, createShutdownApproval, createShutdownRejection, createIdleNotification } from "./mailbox.js";
export { discoverAgents, formatAgentList } from "./agents.js";
export { createTeam, deleteTeam, spawnTeammate, getActiveTeam } from "./teams.js";
export { pollInbox, sendIdleNotification } from "./poller.js";
export { writeAgentMetadata, readAgentMetadata, appendToTranscript, readTranscript, recordSubagentSpawn, recordSubagentResult } from "./aim-transcript.js";
export type { WorkerConfig, WorkerInfo, AgentConfig, AgentScope, AgentDiscoveryResult, TeammateMessage, TeamFile, TeamMember, SubagentSpawnData, SubagentResultData } from "./types.js";

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

// ============================================================================
// Usage Collection
// ============================================================================

function collectUsage(messages: Message[]): SingleResult["usage"] {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, turns = 0;
  for (const msg of messages) {
    if (msg.role === "assistant") {
      turns++;
      const usage = (msg as Record<string, unknown>).usage as Record<string, number> | undefined;
      if (usage) {
        input += usage.input || 0;
        output += usage.output || 0;
        cacheRead += usage.cacheRead || 0;
        cacheWrite += usage.cacheWrite || 0;
      }
    }
  }
  return { input, output, cacheRead, cacheWrite, cost: 0, contextTokens: 0, turns };
}

// ============================================================================
// Subagent result type
// ============================================================================

interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens: number; turns: number };
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  agentId?: string;
  resumed?: boolean;
}

// ============================================================================
// Subagent Execution
// ============================================================================

async function runSingleAgent(
  pi: ExtensionAPI,
  cwd: string,
  agents: AgentConfig[],
  params: {
    agent: string; task: string; fork?: boolean; background?: boolean;
    cwd?: string; model?: string; tools?: string[]; systemPrompt?: string;
    resumeAgentId?: string;
  },
  signal: AbortSignal | undefined,
  onUpdate: ((partial: { agent: string; status: string; output: string }) => void) | undefined,
): Promise<SingleResult> {
  const agentDef = agents.find((a) => a.name === params.agent);

  // --- Resume path ---
  if (params.resumeAgentId) {
    const meta = readAgentMetadata(cwd, params.resumeAgentId);
    if (!meta) throw new Error(`No metadata found for agent ${params.resumeAgentId}`);
    const transcriptMsgs = readTranscript(cwd, params.resumeAgentId);
    if (transcriptMsgs.length === 0) throw new Error(`No transcript found for agent ${params.resumeAgentId}`);

    // Build combined dispatch: RPC mode, pass --session to load existing transcript
    const workerId = workerPool.spawn({
      name: params.agent, prompt: params.task,
      model: params.model ?? meta.model,
      tools: params.tools ?? meta.tools,
      cwd: params.cwd ?? cwd,
      background: params.background ?? meta.background,
      forkFrom: undefined, // resume uses --session, not forkFrom
      systemPrompt: params.systemPrompt,
      rpcMode: true,
      agentId: params.resumeAgentId,
    });

    const info = workerPool.getInfo(workerId);
    if (!info) throw new Error("Worker spawn failed");

    onUpdate?.({ agent: params.agent, status: "running (resumed)", output: "" });

    if (params.background) {
      return {
        agent: params.agent, agentSource: meta.agentType as "user" | "project", task: params.task,
        exitCode: -1, messages: [], stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        agentId: params.resumeAgentId, resumed: true,
      };
    }

    try {
      const result = await workerPool.waitFor(workerId);
      const usage = collectUsage(result.messages);
      const finalOutput = getFinalOutput(result.messages);
      const lastAssistant = result.messages.filter(m => m.role === "assistant").pop() as Record<string, unknown> | undefined;
      const stopReason = lastAssistant?.stopReason as string | undefined;
      const errorMsg = lastAssistant?.errorMessage as string | undefined;

      // Append to transcript
      appendToTranscript(cwd, params.resumeAgentId, result.messages);

      // Record result in parent tree
      recordSubagentResult(pi, {
        agentId: params.resumeAgentId,
        status: result.exitCode === 0 ? "completed" : "failed",
        summary: finalOutput.slice(0, 200),
        usage, exitCode: result.exitCode ?? 1,
        model: result.messages.find(m => m.role === "assistant") && (result.messages.find(m => m.role === "assistant") as Record<string, unknown>).model as string | undefined,
      });

      onUpdate?.({ agent: params.agent, status: result.exitCode === 0 ? "completed" : "error", output: finalOutput });

      return {
        agent: params.agent, agentSource: meta.agentType as "user" | "project", task: params.task,
        exitCode: result.exitCode ?? 1, messages: result.messages, stderr: result.stderr,
        usage, model: params.model, stopReason, errorMessage: errorMsg,
        agentId: params.resumeAgentId, resumed: true,
      };
    } catch (err) {
      return {
        agent: params.agent, agentSource: meta.agentType as "user" | "project", task: params.task,
        exitCode: 1, messages: [], stderr: err instanceof Error ? err.message : String(err),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        agentId: params.resumeAgentId, resumed: true,
      };
    }
  }

  // --- Standard (non-resume) path ---
  if (!agentDef) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: params.agent, agentSource: "unknown", task: params.task, exitCode: 1,
      messages: [], stderr: `Unknown agent: "${params.agent}". Available: ${available}.`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    };
  }

  // Decide mode: fork or background → RPC; simple sync → print
  const useRpc = params.fork || params.background;
  const agentId = useRpc ? `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` : undefined;

  // Persist metadata for RPC agents (enable resume)
  if (agentId) {
    writeAgentMetadata(cwd, agentId, {
      agentType: agentDef.name, name: params.agent, task: params.task,
      model: params.model ?? agentDef.model,
      tools: params.tools ?? agentDef.tools,
      forkMode: params.fork ?? false,
      background: params.background ?? false,
      createdAt: Date.now(),
    });

    // Record spawn in parent tree
    recordSubagentSpawn(pi, {
      agentId, agent: params.agent, task: params.task,
      model: params.model ?? agentDef.model,
      tools: params.tools ?? agentDef.tools,
      background: params.background ?? false,
      forkMode: params.fork ?? false,
      transcriptFile: `.pi/aim/agents/${agentId}.jsonl`,
    });
  }

  const model = params.model ?? agentDef.model;
  const tools = params.tools ?? agentDef.tools;

  // Build system prompt for fork mode: append agent's system prompt
  let systemPrompt: string | undefined;
  if (params.fork) {
    // Fork inherits parent context, but we also inject the agent's role prompt
    systemPrompt = agentDef.systemPrompt;
  }

  // If not fork mode and not background, use agent's system prompt directly
  if (!params.fork && !params.background) {
    systemPrompt = agentDef.systemPrompt;
  }

  const workerId = workerPool.spawn({
    name: params.agent, prompt: params.task,
    model, tools,
    cwd: params.cwd ?? cwd,
    background: params.background ?? false,
    systemPrompt,
    rpcMode: useRpc,
    agentId,
  });

  const info = workerPool.getInfo(workerId);
  if (!info) throw new Error("Worker spawn failed");

  onUpdate?.({ agent: params.agent, status: "running", output: "" });

  if (params.background) {
    return {
      agent: params.agent, agentSource: agentDef.source, task: params.task,
      exitCode: -1, messages: [], stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      agentId, resumed: false,
    };
  }

  try {
    const result = await workerPool.waitFor(workerId);
    const usage = collectUsage(result.messages);
    const finalOutput = getFinalOutput(result.messages);
    const lastAssistant = result.messages.filter(m => m.role === "assistant").pop() as Record<string, unknown> | undefined;
    const stopReason = lastAssistant?.stopReason as string | undefined;
    const errorMsg = lastAssistant?.errorMessage as string | undefined;

    // Persist transcript for RPC agents
    if (agentId) {
      appendToTranscript(cwd, agentId, result.messages);
      recordSubagentResult(pi, {
        agentId, status: result.exitCode === 0 ? "completed" : "failed",
        summary: finalOutput.slice(0, 200), usage, exitCode: result.exitCode ?? 1, model,
      });
    }

    onUpdate?.({ agent: params.agent, status: result.exitCode === 0 ? "completed" : "error", output: finalOutput });

    return {
      agent: params.agent, agentSource: agentDef.source, task: params.task,
      exitCode: result.exitCode ?? 1, messages: result.messages, stderr: result.stderr,
      usage, model: params.model, stopReason, errorMessage: errorMsg,
      agentId, resumed: false,
    };
  } catch (err) {
    return {
      agent: params.agent, agentSource: agentDef.source, task: params.task,
      exitCode: 1, messages: [], stderr: err instanceof Error ? err.message : String(err),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      agentId, resumed: false,
    };
  }
}

// ============================================================================
// Schema Definitions
// ============================================================================

const TaskItem = Type.Object({
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
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel execution" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential execution" })),
  agentScope: Type.Optional(AgentScopeSchema),
  fork: Type.Optional(Type.Boolean({ description: "Fork current session (inherit context)", default: false })),
  background: Type.Optional(Type.Boolean({ description: "Run in background", default: false })),
  model: Type.Optional(Type.String({ description: "Model override" })),
  team_name: Type.Optional(Type.String({ description: "Team name for teammate spawn" })),
  teammate_name: Type.Optional(Type.String({ description: "Name for spawned teammate" })),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
  resume: Type.Optional(Type.String({ description: "Agent ID to resume (continue previous subagent conversation)" })),
});

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {

  // ========== SUBAGENT TOOL ==========

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
      "Run independent subagents in parallel (tasks array) to maximize throughput.",
      "Use fork:true for research tasks — the subagent inherits your context.",
      "Use background:true for long tasks — results arrive via notification.",
      "Use resume:<id> to continue a previous agent — look for agent IDs in prior subagent results.",
    ],
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const scope: AgentScope = params.agentScope ?? "user";
      const { agents } = discoverAgents(ctx.cwd, scope);
      const cwd = ctx.cwd;

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
        const result = await runSingleAgent(pi, cwd, agents, {
          agent: "resumed", task: params.task ?? "",
          background: params.background, model: params.model,
          resumeAgentId: params.resume,
        }, signal, (up) => onUpdate?.({ content: [{ type: "text", text: `${up.agent}: ${up.status}` }], details: { mode: "resume", ...up } }));

        if (params.background) {
          return {
            content: [{ type: "text", text: `Resumed agent ${params.resume} in background.` }],
            details: { mode: "resume", background: true, agentId: result.agentId },
          };
        }
        return {
          content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
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
        const results: SingleResult[] = [];
        let prev = "";
        for (let i = 0; i < params.chain.length; i++) {
          const s = params.chain[i];
          const r = await runSingleAgent(pi, cwd, agents, {
            agent: s.agent, task: s.task.replace(/\{previous\}/g, prev),
            cwd: s.cwd, model: s.model,
          }, signal, (up) => onUpdate?.({ content: [{ type: "text", text: `[${i + 1}/${params.chain!.length}] ${up.agent}: ${up.status}` }], details: { mode: "chain", step: i + 1, ...up } }));
          results.push(r);
          if (r.exitCode !== 0 && r.stopReason !== undefined) {
            const err = r.errorMessage || r.stderr || "(no output)";
            return { content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${s.agent}): ${err}` }], details: { mode: "chain", results, error: true }, isError: true };
          }
          prev = getFinalOutput(r.messages);
        }
        return { content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }], details: { mode: "chain", results } };
      }

      // --- Parallel ---
      if (params.tasks?.length) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          return { content: [{ type: "text", text: `Max ${MAX_PARALLEL_TASKS} tasks.` }], details: { mode: "parallel", error: true } };
        }
        const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t) =>
          runSingleAgent(pi, cwd, agents, { agent: t.agent, task: t.task, cwd: t.cwd, model: t.model, tools: t.tools }, signal, (up) => onUpdate?.({ content: [{ type: "text", text: `[parallel] ${up.agent}: ${up.status}` }], details: { mode: "parallel", ...up } }))
        );
        const ok = results.filter(r => r.exitCode === 0).length;
        const lines = results.map(r => `[${r.agent}] ${r.exitCode === 0 ? "✓" : "✗"}: ${getFinalOutput(r.messages).slice(0, 100) || "(no output)"}`);
        return { content: [{ type: "text", text: `Parallel: ${ok}/${results.length} OK\n\n${lines.join("\n\n")}` }], details: { mode: "parallel", results } };
      }

      // --- Single ---
      if (params.agent && params.task) {
        const result = await runSingleAgent(pi, cwd, agents, {
          agent: params.agent, task: params.task,
          fork: params.fork, background: params.background,
          cwd: params.cwd, model: params.model,
        }, signal, (up) => onUpdate?.({ content: [{ type: "text", text: `${up.agent}: ${up.status}` }], details: { mode: "single", ...up } }));

        if (params.background) {
          return { content: [{ type: "text", text: `Background agent "${params.agent}" launched. Agent ID: ${result.agentId}. Use resume: to continue.` }], details: { mode: "single", background: true, agentId: result.agentId } };
        }
        if (result.exitCode !== 0 && result.stopReason !== undefined) {
          const err = result.errorMessage || result.stderr || "(no output)";
          return { content: [{ type: "text", text: `Agent ${result.stopReason}: ${err}` }], details: { mode: "single", result }, isError: true };
        }
        return { content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }], details: { mode: "single", result } };
      }

      return { content: [{ type: "text", text: `Invalid params. Available: ${agents.map(a => a.name).join(", ") || "none"}` }], details: { mode: "invalid" } };
    },

    // ========== RENDER ==========

    renderCall(args, theme, _context) {
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

    renderResult(result, { expanded }, theme, _ctx) {
      const details = result.details as Record<string, unknown> | undefined;
      if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
      const mdTheme = getMarkdownTheme();

      if (details.mode === "single" || details.mode === "resume") {
        const r = details.result as SingleResult | undefined;
        if (r) return renderSubagentResult(result, expanded, theme, r.agent, r.agentSource, r.task, r.model, r.usage, r.stopReason, r.errorMessage);
      }

      if (details.mode === "chain") {
        const results = (details.results ?? []) as SingleResult[];
        const ok = results.filter(r => r.exitCode === 0).length;
        const icon = ok === results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
        if (expanded) {
          const c = new Container();
          c.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${ok}/${results.length} steps`)}`, 0, 0));
          for (const r of results) {
            const ri = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
            c.addChild(new Spacer(1));
            c.addChild(new Text(`${theme.fg("muted", `Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${ri}`, 0, 0));
            c.addChild(new Text(theme.fg("dim", r.task), 0, 0));
            for (const item of getDisplayItems(r.messages).filter(x => x.type === "toolCall")) {
              c.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args as Record<string, unknown>, theme), 0, 0));
            }
            const out = getFinalOutput(r.messages); if (out) { c.addChild(new Spacer(1)); c.addChild(new Markdown(out.trim(), 0, 0, mdTheme)); }
            const u = formatUsageStats(r.usage, r.model); if (u) c.addChild(new Text(theme.fg("dim", u), 0, 0));
          }
          const totalU = formatUsageStats(results.reduce((s, r) => ({ input: s.input + r.usage.input, output: s.output + r.usage.output, cacheRead: s.cacheRead + r.usage.cacheRead, cacheWrite: s.cacheWrite + r.usage.cacheWrite, cost: s.cost + r.usage.cost, turns: s.turns + r.usage.turns }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }));
          if (totalU) { c.addChild(new Spacer(1)); c.addChild(new Text(theme.fg("dim", `Total: ${totalU}`), 0, 0)); }
          return c;
        }
        let t = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${ok}/${results.length}`)}`;
        for (const r of results) {
          const ri = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
          t += `\n${theme.fg("accent", r.agent)} ${ri}`;
          const items = getDisplayItems(r.messages).slice(-5);
          for (const i of items) t += `\n  ${i.type === "text" ? theme.fg("toolOutput", i.text) : theme.fg("muted", "→ ") + formatToolCall(i.name, i.args as Record<string, unknown>, theme)}`;
        }
        t += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(t, 0, 0);
      }

      if (details.mode === "parallel") {
        const results = (details.results ?? []) as SingleResult[];
        const running = results.filter(r => r.exitCode === -1).length;
        const ok = results.filter(r => r.exitCode === 0).length;
        const fail = results.filter(r => r.exitCode > 0).length;
        const icon = running > 0 ? theme.fg("warning", "⏳") : fail > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
        const st = running > 0 ? `${ok + fail}/${results.length} done, ${running} running` : `${ok}/${results.length}`;
        let t = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", st)}`;
        for (const r of results) {
          const ri = r.exitCode === -1 ? theme.fg("warning", "⏳") : r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
          t += `\n${theme.fg("accent", r.agent)} ${ri}`;
          const items = getDisplayItems(r.messages).slice(-3);
          for (const i of items) t += `\n  ${i.type === "text" ? theme.fg("toolOutput", i.text) : theme.fg("muted", "→ ") + formatToolCall(i.name, i.args as Record<string, unknown>, theme)}`;
        }
        return new Text(t, 0, 0);
      }

      const content = result.content[0];
      return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
    },
  });

  // ========== REGISTER SUBSYSTEMS ==========

  registerSendMessage(pi);
  registerCoordinator(pi);
  registerTeams(pi);
  registerPermissions(pi);
}