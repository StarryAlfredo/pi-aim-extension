/**
 * AIM — WorkerPool
 *
 * Manages lifecycle of child pi processes. Supports two modes:
 *
 *   Print mode (one-shot):  pi --mode json -p "task"
 *     Process exits after completing the prompt. Results collected via stdout.
 *
 *   RPC mode (long-lived):  pi --mode rpc
 *     Process stays alive. Commands sent via stdin JSON, events received via stdout.
 *     Supports steering, follow-up, abort, and multi-turn conversations.
 *     Used for: fork (inherit context), background agents that can be resumed.
 *
 *   agent_end handling (P1):
 *     - agent_end = worker completed one prompt cycle. Sets worker state to "idle",
 *       resolves donePromise so callers can wait for completion.
 *     - worker stays alive in idle state, ready for next command (steer/follow_up/resume).
 *     - close event only fires on kill() or print mode exit.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "@mariozechner/pi-ai";
import type { WorkerConfig, WorkerInfo, WorkerState } from "./types.js";
import {
  createProgressTracker,
  recordToolUse,
  recordTokenUsage,
  recordTurn,
  recordStatusChange,
  recordError,
  removeProgressTracker,
  persistProgress,
  deletePersistedProgress,
  type TaskProgress,
} from "./task-progress.js";

// ============================================================================
// Helpers
// ============================================================================

function fileExists(p: string): boolean {
  try { fs.statSync(p); return true; } catch { return false; }
}

/** Get the pi executable path */
function getPiCommand(): { command: string; args: string[] } {
  const execPath = process.argv[1];
  if (execPath && fileExists(execPath)) {
    return { command: process.execPath, args: [execPath] };
  }

  // On Windows, Node.js spawn() cannot directly execute .cmd files (EINVAL).
  // Instead, resolve pi.cmd to find the actual JS entry point and use node.
  if (process.platform === "win32" && process.execPath) {
    const nodeDir = path.dirname(process.execPath);
    const cliJs = path.join(nodeDir, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js");
    if (fileExists(cliJs)) {
      return { command: process.execPath, args: [cliJs] };
    }
    // Fallback: try the .bin symlink path
    const binCliJs = path.join(nodeDir, "node_modules", ".bin", "pi");
    if (fileExists(binCliJs)) {
      return { command: process.execPath, args: [binCliJs] };
    }
  }

  if (process.execPath) {
    const nodeDir = path.dirname(process.execPath);
    const candidates = [
      path.join(nodeDir, "pi"),
      path.join(nodeDir, "node_modules", ".bin", "pi"),
    ];
    for (const c of candidates) { if (fileExists(c)) return { command: c, args: [] }; }
  }

  const isWin = process.platform === "win32";
  return { command: isWin ? "pi.cmd" : "pi", args: [] };
}

// ============================================================================
// WorkerPool
// ============================================================================

export class WorkerPool {
  private workers = new Map<string, WorkerInfo>();

  get total(): number { return this.workers.size; }

  get running(): number {
    let c = 0;
    for (const w of this.workers.values()) {
      if (w.state === "running" || w.state === "starting") c++;
    }
    return c;
  }

  /**
   * Spawn a child pi process. Returns workerId.
   *
   * Print mode (default):
   *   pi --mode json -p --no-session [--model X] [--tools a,b] "prompt"
   *   Process exits after completion.
   *
   * RPC mode (rpcMode: true):
   *   pi --mode rpc --no-session [--model X] [--tools a,b]
   *   Process stays alive. Initial prompt sent via stdin.
   *   donePromise resolves on agent_end, NOT on process close.
   */
  spawn(config: Omit<WorkerConfig, "workerId">): string {
    const workerId = randomUUID();
    const fullConfig: WorkerConfig = { ...config, workerId };

    const isRpc = config.rpcMode === true;
    const args: string[] = isRpc
      ? ["--mode", "rpc", "--no-session"]
      : ["--mode", "json", "-p", "--no-session"];

    if (config.model) args.push("--model", config.model);
    if (config.tools?.length) args.push("--tools", config.tools.join(","));
    if (config.forkFrom) args.push("--session", config.forkFrom);

    // For print mode: prompt is the last positional arg
    if (!isRpc) args.push(config.prompt);

    const piCmd = getPiCommand();
    // P2: Pass teammate identity via environment variables so child processes
    // can detect they are teammates and use mailbox-based permission requests
    // instead of trying to show local confirmation dialogs.
    const envExtra: Record<string, string> = {};
    if (config.name) envExtra.TEAMMATE_NAME = config.name;
    // Team name is not in WorkerConfig directly — it's passed via the
    // spawnTeammate flow in teams.ts which sets it on the config.
    // We use a custom field to pass it through to the child process.
    const teamName = (config as Record<string, unknown>).team_name as string | undefined;
    if (teamName) envExtra.TEAMMATE_TEAM = teamName;

    const proc = spawn(piCmd.command, [...piCmd.args, ...args], {
      cwd: config.cwd ?? process.cwd(),
      stdio: isRpc ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...envExtra },
    });

    const info: WorkerInfo = {
      config: fullConfig,
      state: "starting",
      pid: proc.pid,
      startedAt: Date.now(),
      messages: [],
      stderr: "",
      process: proc,
      rpcSend: isRpc ? (json: string) => {
        if (!proc.stdin?.destroyed) proc.stdin?.write(json + "\n");
      } : undefined,
      /** Number of agent_end events received (for multi-turn tracking) */
      turnCount: 0,
    };

    // P3: Create progress tracker for this worker if agentId is set
    if (config.agentId) {
      createProgressTracker(config.agentId);
      recordStatusChange(config.agentId, "worker_spawned");
    }

    // donePromise: resolves on agent_end (RPC) or close (print)
    // Reset for each turn in RPC mode via resetDonePromise()
    info.donePromise = new Promise((resolve, reject) => {
      info.doneResolve = resolve;
      info.doneReject = reject;
    });
    if (config.background) info.donePromise.catch(() => {});

    this.workers.set(workerId, info);

    // Parse stdout JSON stream (both modes)
    this.attachStdout(proc, info);

    // Collect stderr
    proc.stderr?.on("data", (data: Buffer) => { info.stderr += data.toString(); });

    proc.on("spawn", () => {
      info.state = "running";
      // RPC mode: send initial prompt after process starts
      if (isRpc && info.rpcSend) {
        info.rpcSend(JSON.stringify({ type: "prompt", message: config.prompt }));
      }
    });

    proc.on("close", (code) => {
      info.state = "dead";
      info.exitCode = code ?? undefined;
      // Resolve donePromise if still pending (e.g. print mode, or kill() before agent_end)
      if (info.doneResolve) {
        code === 0 ? info.doneResolve() : info.doneReject?.(new Error(`Worker exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      info.state = "dead";
      info.exitCode = 1;
      info.stderr += err.message;
      if (info.doneReject) info.doneReject(err);
    });

    return workerId;
  }

  /**
   * Reset donePromise for the next turn in RPC mode.
   * Called after agent_end when a new prompt is being sent (steer/follow_up).
   */
  private resetDonePromise(info: WorkerInfo) {
    if (info.doneResolve) {
      // Previous promise already resolved — create new one
      info.donePromise = new Promise((resolve, reject) => {
        info.doneResolve = resolve;
        info.doneReject = reject;
      });
    }
  }

  /** Send a steering message to a running RPC worker (interrupts current tool execution) */
  steer(workerId: string, message: string): boolean {
    const info = this.workers.get(workerId);
    if (!info?.rpcSend || (info.state !== "running" && info.state !== "idle")) return false;
    this.resetDonePromise(info);
    info.state = "running";
    info.rpcSend(JSON.stringify({ type: "steer", message }));
    return true;
  }

  /** Queue a follow-up message for after the worker finishes */
  followUp(workerId: string, message: string): boolean {
    const info = this.workers.get(workerId);
    if (!info?.rpcSend || info.state === "dead") return false;
    this.resetDonePromise(info);
    if (info.state !== "running") info.state = "running";
    info.rpcSend(JSON.stringify({ type: "follow_up", message }));
    return true;
  }

  /** Abort a running RPC worker */
  abort(workerId: string): boolean {
    const info = this.workers.get(workerId);
    if (!info?.rpcSend || info.state === "dead") return false;
    info.rpcSend(JSON.stringify({ type: "abort" }));
    return true;
  }

  /**
   * Parse JSON event stream from worker stdout.
   *
   * Events collected:
   *   - message_end, tool_result_end → appended to info.messages
   *   - agent_end → sets info.state="idle", resolves donePromise, increments turnCount
   *
   * Print mode: process exits after last agent_end, close handler fires.
   * RPC mode: agent_end fires but process stays alive for multi-turn.
   */
  private attachStdout(proc: ChildProcess, info: WorkerInfo) {
    let buffer = "";
    proc.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;

          // P3: Track tool usage in progress tracker
          // Detect tool_use_start events from the JSON stream
          if (event.type === "tool_use_start" && event.tool_name) {
            const agentId = info.config.agentId;
            if (agentId) recordToolUse(agentId, event.tool_name as string);
          }

          // P3: Track tool_result with token usage
          if (event.type === "tool_result_end" && event.message) {
            info.messages.push(event.message as Message);
            // Extract usage from tool results if available
            const agentId = info.config.agentId;
            if (agentId && event.usage) {
              const usage = event.usage as Record<string, number>;
              recordTokenUsage(agentId, {
                input: usage.input ?? 0,
                output: usage.output ?? 0,
                cacheRead: usage.cacheRead ?? 0,
                cacheWrite: usage.cacheWrite ?? 0,
              });
            }
          }

          // Collect messages
          if ((event.type === "message_end" || (event.type === "tool_result_end" && !event.message)) && event.message) {
            info.messages.push(event.message as Message);
          }

          // P3: Track assistant message tokens on message_end
          if (event.type === "message_end") {
            const agentId = info.config.agentId;
            if (agentId) {
              recordTurn(agentId);
              // Extract usage from the message if present
              if (event.usage) {
                const usage = event.usage as Record<string, number>;
                recordTokenUsage(agentId, {
                  input: usage.input ?? 0,
                  output: usage.output ?? 0,
                  cacheRead: usage.cacheRead ?? 0,
                  cacheWrite: usage.cacheWrite ?? 0,
                });
              }
            }
          }

          // P1: agent_end = worker completed one turn
          if (event.type === "agent_end") {
            info.turnCount = (info.turnCount || 0) + 1;
            info.state = "idle";
            // Mark as success — the agent completed its turn
            if (info.exitCode === undefined) info.exitCode = 0;

            // Store usage from agent_end for idle notifications
            if (event.usage) {
              (info as Record<string, unknown>).lastUsage = event.usage;
              // P3: Record final token usage from agent_end
              const agentId = info.config.agentId;
              if (agentId) {
                const usage = event.usage as Record<string, number>;
                recordTokenUsage(agentId, {
                  input: usage.input ?? 0,
                  output: usage.output ?? 0,
                  cacheRead: usage.cacheRead ?? 0,
                  cacheWrite: usage.cacheWrite ?? 0,
                });
                recordTurn(agentId);
                recordStatusChange(agentId, "agent_end (turn complete)");
              }
            }

            // Resolve donePromise — callers waiting on waitFor() are unblocked
            if (info.doneResolve) {
              info.doneResolve();
            }
          }
        } catch { /* ignore non-JSON lines */ }
      }
    });
  }

  /** Kill a worker by ID. Returns true if worker existed. */
  kill(workerId: string): boolean {
    const info = this.workers.get(workerId);
    if (!info || info.state === "dead") return false;
    try {
      info.state = "dead";
      // P3: Record error and clean up progress tracker
      const agentId = info.config.agentId;
      if (agentId) {
        recordError(agentId, "worker_killed");
      }
      process.kill(info.pid!, "SIGTERM");
      setTimeout(() => {
        if (info.state !== "dead") { try { process.kill(info.pid!, "SIGKILL"); } catch {} }
      }, 5000);
      return true;
    } catch { return false; }
  }

  getInfo(workerId: string): WorkerInfo | undefined { return this.workers.get(workerId); }
  getAll(): WorkerInfo[] { return Array.from(this.workers.values()); }

  async waitFor(workerId: string): Promise<WorkerInfo> {
    const info = this.workers.get(workerId);
    if (!info) throw new Error(`Worker not found: ${workerId}`);
    await info.donePromise;
    return info;
  }

  destroy() {
    for (const [id] of this.workers) this.kill(id);
    this.workers.clear();
  }
}

export const workerPool = new WorkerPool();