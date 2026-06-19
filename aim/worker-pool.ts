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
import type { Message } from "@earendil-works/pi-ai";
import type { WorkerConfig, WorkerInfo, WorkerState } from "./types.js";
import {
  recordToolUse,
  recordTokenUsage,
  recordTurn,
  recordStatusChange,
  recordError,
} from "./task-progress.js";

// ============================================================================
// Helpers
// ============================================================================

function fileExists(p: string): boolean {
  try { fs.statSync(p); return true; } catch { return false; }
}

/**
 * Resolve pi's CLI entry point (cli.js) reliably across all platforms
 * and installation methods.
 *
 * Strategy (ordered by reliability):
 *   1. npm root -g → find the global pi installation (works everywhere)
 *   2. process.argv[1] → if running as pi directly (dev mode)
 *   3. which/where pi → fallback, parse the wrapper to extract cli.js path
 *
 * Always returns { command: nodeExe, args: [cliJs] } — never .cmd files
 * or shell:true, which break on MSYS2/Cygwin/MINGW environments.
 */
function getPiCommand(): { command: string; args: string[] } {
  // Strategy 1: npm root -g — finds the global node_modules directory.
  // Works regardless of where Node.js is installed (portable, nvm, global npm).
  // This is the same mechanism npm itself uses to locate global packages.
  try {
    const { execSync } = require("node:child_process");
    const npmRoot = execSync("npm root -g", {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    }).trim();
    if (npmRoot) {
      const cliJs = path.join(
        npmRoot,
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "cli.js",
      );
      if (fileExists(cliJs)) {
        return { command: process.execPath, args: [cliJs] };
      }
    }
  } catch {
    // npm root -g failed — continue to next strategy
  }

  // Strategy 2: process.argv[1] — the script currently being executed.
  // In a pi process, this is cli.js. Works for direct node invocations.
  const argv1 = process.argv[1];
  if (argv1 && fileExists(argv1)) {
    const baseName = path.basename(argv1);
    if (baseName === "cli.js" || baseName === "pi" || baseName === "pi.js") {
      return { command: process.execPath, args: [argv1] };
    }
  }

  // Strategy 3: which/where pi — parse the wrapper script to extract the
  // real cli.js path from node_modules, then invoke via node directly.
  // Avoids .cmd + shell:true which fails on MSYS2/Cygwin/MINGW.
  try {
    const { execSync: es2 } = require("node:child_process");
    const whichCmd = process.platform === "win32" ? "where pi" : "which pi";
    const result = es2(whichCmd, {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
    }).trim();
    if (result) {
      const firstLine = result.split("\n")[0]!.trim();

      if (process.platform === "win32") {
        // The .cmd wrapper references: "%dp0%\node_modules\@earendil-works\pi-coding-agent\dist\cli.js"
        // We can derive the cli.js path from the .cmd location.
        // If the .cmd is at: <npm_prefix>/pi.cmd
        // Then cli.js is at: <npm_prefix>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
        const cmdDir = path.dirname(firstLine);
        const cliJs = path.join(
          cmdDir,
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
          "dist",
          "cli.js",
        );
        if (fileExists(cliJs)) {
          return { command: process.execPath, args: [cliJs] };
        }
      } else {
        // On Unix, which pi returns a POSIX shell script.
        // Parse it to find the cli.js path (used as fallback).
        if (fileExists(firstLine)) {
          try {
            const content = fs.readFileSync(firstLine, "utf-8");
            // Look for: exec node "...cli.js" or exec .../node_modules/.../cli.js
            const cliMatch = content.match(
              /node_modules\/@earendil-works\/pi-coding-agent\/dist\/cli\.js/,
            );
            if (cliMatch) {
              const scriptDir = path.dirname(firstLine);
              const cliJs = path.join(scriptDir, cliMatch[0]);
              if (fileExists(cliJs)) {
                return { command: process.execPath, args: [cliJs] };
              }
            }
          } catch {
            // Can't read the script — fall through
          }
        }
      }
    }
  } catch {
    // which/where failed — fall through
  }

  // Strategy 4: absolute last resort. Try to locate cli.js relative to the
  // Node.js binary's directory (works for portable/bundled installs).
  if (process.execPath) {
    const nodeDir = path.dirname(process.execPath);
    const candidates = [
      path.join(nodeDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      path.join(nodeDir, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js"),
    ];
    for (const c of candidates) {
      if (fileExists(c)) return { command: process.execPath, args: [c] };
    }
  }

  // Last resort: hope pi/pi.cmd is on PATH and shell:true works.
  // This may fail on MSYS2/Cygwin/MINGW but there's nothing else to try.
  const isWin = process.platform === "win32";
  return { command: isWin ? "pi.cmd" : "pi", args: [] };
}

// ============================================================================
// WorkerPool
// ============================================================================

export class WorkerPool {
  private workers = new Map<string, WorkerInfo>();
  /** Pending SIGKILL escalation timers, tracked so destroy() can clear them
   *  instead of leaving handles dangling on the event loop. */
  private pendingKillTimers = new Set<ReturnType<typeof setTimeout>>();

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
    // Team name is passed via the typed WorkerConfig.team_name field (previously
    // threaded through an unsafe `(config as Record).team_name` cast).
    if (config.team_name) envExtra.TEAMMATE_TEAM = config.team_name;

    // Determine shell mode: only needed if we fell through to a .cmd/.bat
    // wrapper. The preferred path (npm root -g → cli.js) uses node.exe + cli.js
    // directly, which never needs shell:true.
    const needsShell =
      process.platform === "win32" && piCmd.command.endsWith(".cmd");

    const proc = spawn(piCmd.command, [...piCmd.args, ...args], {
      cwd: config.cwd ?? process.cwd(),
      // Always use pipe for stdin on Windows print mode, then close it.
      // stdio: 'ignore' for stdin causes pi subprocesses to hang on
      // MSYS2/Cygwin/MINGW due to how those environments emulate stdio.
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...envExtra },
      shell: needsShell,
    });

    // Close stdin immediately for print mode — pi doesn't read stdin
    // in print mode and an open-but-unused pipe can cause hangs on MSYS2.
    if (!isRpc && proc.stdin) {
      proc.stdin.end();
    }

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

    // Progress tracking is created by agent-executor.ts before calling spawn(),
    // so events from attachStdout are never lost. WorkerPool only records events
    // into the tracker — it does not own the lifecycle.

    // donePromise: resolves on agent_end (RPC) or close (print)
    // Reset for each turn in RPC mode via resetDonePromise()
    info.donePromise = new Promise((resolve, reject) => {
      info.doneResolve = resolve;
      info.doneReject = reject;
    });
    // Background workers run fire-and-forget: attach a logged catch so a late
    // rejection (e.g. non-zero exit) is reported instead of becoming an
    // unhandled rejection. Foreground workers surface rejection via waitFor().
    if (config.background) {
      info.donePromise.catch(err => {
        console.warn(`[aim] Background worker ${config.name} (${workerId}) failed:`, err);
      });
    }

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
              (info as unknown as Record<string, unknown>).lastUsage = event.usage;
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

  /** Kill a worker by ID. Returns true if worker existed and kill was initiated.
   *
   *  Sends SIGTERM, then escalates to SIGKILL after a 5s grace period IF the
   *  process hasn't exited yet. The escalation timer is tracked on
   *  `pendingKillTimers` so `destroy()` can clear it. */
  kill(workerId: string): boolean {
    const info = this.workers.get(workerId);
    if (!info || info.state === "dead" || info.killing) return false;
    info.killing = true;
    try {
      // P3: Record error and clean up progress tracker
      const agentId = info.config.agentId;
      if (agentId) {
        recordError(agentId, "worker_killed");
      }
      process.kill(info.pid!, "SIGTERM");
      // Escalate to SIGKILL after grace period if the process hasn't exited.
      // `info.exitCode === undefined` means the close event hasn't fired yet
      // (i.e. the process is still alive) — that's the correct condition for
      // force-killing. The previous code checked `info.state !== "dead"`, but
      // nothing set state to dead here, so SIGKILL never fired — a real bug.
      const timer = setTimeout(() => {
        this.pendingKillTimers.delete(timer);
        if (info.exitCode === undefined) {
          try { process.kill(info.pid!, "SIGKILL"); } catch {}
        }
      }, 5000);
      if (timer.unref) timer.unref();
      this.pendingKillTimers.add(timer);
      return true;
    } catch { return false; }
  }

  getInfo(workerId: string): WorkerInfo | undefined { return this.workers.get(workerId); }
  getAll(): WorkerInfo[] { return Array.from(this.workers.values()); }

  async waitFor(workerId: string, timeoutMs?: number): Promise<WorkerInfo> {
    const info = this.workers.get(workerId);
    if (!info) throw new Error(`Worker not found: ${workerId}`);

    if (timeoutMs && timeoutMs > 0) {
      // Race between donePromise and timeout. The timeout timer is cleared in
      // `finally` so it doesn't keep the event loop alive or leak after success.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Worker ${workerId} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        if (timer.unref) timer.unref();
      });
      try {
        await Promise.race([info.donePromise, timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
        // The caller abandoned this worker on timeout; suppress the late
        // rejection (if any) to avoid an unhandled-rejection warning.
        info.donePromise?.catch(() => {});
      }
      return info;
    }
    await info.donePromise;
    return info;
  }

  destroy() {
    for (const [id] of this.workers) this.kill(id);
    // Clear any pending SIGKILL escalation timers so destroy() doesn't leave
    // handles dangling on the event loop.
    for (const timer of this.pendingKillTimers) clearTimeout(timer);
    this.pendingKillTimers.clear();
    this.workers.clear();
  }
}

export const workerPool = new WorkerPool();