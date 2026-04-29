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
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "@mariozechner/pi-ai";
import type { WorkerConfig, WorkerInfo, WorkerState } from "./types.js";

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
  if (process.execPath) {
    const nodeDir = path.dirname(process.execPath);
    const candidates = [
      path.join(nodeDir, "pi.cmd"), path.join(nodeDir, "pi"),
      path.join(nodeDir, "node_modules", ".bin", "pi.cmd"),
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
    const proc = spawn(piCmd.command, [...piCmd.args, ...args], {
      cwd: config.cwd ?? process.cwd(),
      stdio: isRpc ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
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
    };

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
      code === 0 ? info.doneResolve?.() : info.doneReject?.(new Error(`Worker exited with code ${code}`));
    });

    proc.on("error", (err) => {
      info.state = "dead";
      info.exitCode = 1;
      info.stderr += err.message;
      info.doneReject?.(err);
    });

    return workerId;
  }

  /** Send a steering message to a running RPC worker (interrupts current tool execution) */
  steer(workerId: string, message: string): boolean {
    const info = this.workers.get(workerId);
    if (!info?.rpcSend || info.state !== "running") return false;
    info.rpcSend(JSON.stringify({ type: "steer", message }));
    return true;
  }

  /** Queue a follow-up message for after the worker finishes */
  followUp(workerId: string, message: string): boolean {
    const info = this.workers.get(workerId);
    if (!info?.rpcSend || info.state === "dead") return false;
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

  /** Parse JSON event stream from worker stdout (both print and RPC modes) */
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
          // Collect message_end and tool_result_end events
          if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
            info.messages.push(event.message as Message);
          }
          // RPC mode: a "response" with success:false on prompt indicates error
          // but we don't kill the process — just track it
        } catch { /* ignore non-JSON */ }
      }
    });
  }

  kill(workerId: string): boolean {
    const info = this.workers.get(workerId);
    if (!info || info.state === "dead") return false;
    try {
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