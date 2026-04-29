/**
 * AIM — WorkerPool
 *
 * Manages lifecycle of child pi processes. Each worker is an independent
 * OS process running `pi --mode json -p` (or `--mode rpc` for long-lived agents).
 *
 * Responsibilities:
 * - Spawn child processes with correct CLI flags
 * - Track process state (starting → running → idle → dead)
 * - Collect stdout/stderr and parse JSON event stream
 * - Notify callers on completion (sync mode) or fire-and-forget (background mode)
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "@mariozechner/pi-ai";
import type { WorkerConfig, WorkerInfo, WorkerState } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

const MAX_CONCURRENT = 4;
const MAX_TOTAL = 8;

// ============================================================================
// Helpers
// ============================================================================

/** Check if a file exists */
function fileExists(p: string): boolean {
  try {
    const { statSync } = require("node:fs") as typeof import("node:fs");
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Get the pi executable path. Tries current process argv first, falls back to "pi" */
function getPiCommand(): { command: string; args: string[] } {
  const execPath = process.argv[1];
  if (execPath && fileExists(execPath)) {
    return { command: process.execPath, args: [execPath] };
  }
  return { command: "pi", args: [] };
}

// ============================================================================
// WorkerPool
// ============================================================================

export class WorkerPool {
  private workers = new Map<string, WorkerInfo>();
  private pending: Array<() => void> = [];

  /** Total number of managed workers (alive + dead) */
  get total(): number {
    return this.workers.size;
  }

  /** Number of currently running workers */
  get running(): number {
    let count = 0;
    for (const w of this.workers.values()) {
      if (w.state === "running" || w.state === "starting") count++;
    }
    return count;
  }

  /**
   * Spawn a child pi process. Returns workerId (sync) or fires callback on
   * completion (background).
   */
  spawn(config: Omit<WorkerConfig, "workerId">): string {
    if (this.total >= MAX_TOTAL) {
      throw new Error(`Max worker limit reached (${MAX_TOTAL}). Kill some workers first.`);
    }

    const workerId = randomUUID();
    const fullConfig: WorkerConfig = { ...config, workerId };

    // Build CLI args
    const args: string[] = ["--mode", "json", "-p", "--no-session"];

    if (config.model) args.push("--model", config.model);
    if (config.tools && config.tools.length > 0) args.push("--tools", config.tools.join(","));

    // Fork mode: inherit parent session context via --append-system-prompt
    // Note: Full context inheritance (messages) would require reading the
    // parent JSONL and passing it as --session, which we do in the subagent tool.
    // This base WorkerPool only handles the simple case.
    if (config.forkFrom) {
      args.push("--session", config.forkFrom);
    }

    if (config.systemPrompt) {
      // Write system prompt to a temp file and pass via --append-system-prompt
      // TODO: implement temp file approach in subagent tool
      args.push("--append-system-prompt", config.systemPrompt);
    }

    // Add the task prompt as the final positional argument
    args.push(config.prompt);

    const piCmd = getPiCommand();
    const proc = spawn(piCmd.command, [...piCmd.args, ...args], {
      cwd: config.cwd ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const info: WorkerInfo = {
      config: fullConfig,
      state: "starting",
      pid: proc.pid,
      startedAt: Date.now(),
      messages: [],
      stderr: "",
    };

    if (config.background) {
      // Fire-and-forget: set up donePromise for tracking but don't block
      info.donePromise = new Promise((resolve, reject) => {
        info.doneResolve = resolve;
        info.doneReject = reject;
      });
    }

    this.workers.set(workerId, info);

    // Parse stdout JSON stream
    this.attachStdout(proc, info);

    // Collect stderr
    proc.stderr?.on("data", (data: Buffer) => {
      info.stderr += data.toString();
    });

    proc.on("spawn", () => {
      info.state = "running";
    });

    proc.on("close", (code) => {
      info.state = "dead";
      info.exitCode = code ?? undefined;
      if (info.doneResolve) {
        code === 0 ? info.doneResolve() : info.doneReject?.(new Error(`Worker exited with code ${code}`));
      }
      this.dequeuePending();
    });

    proc.on("error", (err) => {
      info.state = "dead";
      info.exitCode = 1;
      info.stderr += err.message;
      info.doneReject?.(err);
      this.dequeuePending();
    });

    return workerId;
  }

  /** Parse JSON event stream from worker stdout */
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
          if (event.type === "message_end" && event.message) {
            info.messages.push(event.message as Message);
          }
          if (event.type === "tool_result_end" && event.message) {
            info.messages.push(event.message as Message);
          }
        } catch {
          // Ignore non-JSON lines (stray output)
        }
      }
    });
  }

  /** Kill a worker by ID. Returns true if worker existed and was killed. */
  kill(workerId: string): boolean {
    const info = this.workers.get(workerId);
    if (!info || info.state === "dead") return false;

    try {
      process.kill(info.pid!, "SIGTERM");
      // Give 5s for graceful shutdown, then force kill
      setTimeout(() => {
        if (info.state !== "dead") {
          try { process.kill(info.pid!, "SIGKILL"); } catch { /* ignore */ }
        }
      }, 5000);
      return true;
    } catch {
      return false;
    }
  }

  /** Get info for a specific worker */
  getInfo(workerId: string): WorkerInfo | undefined {
    return this.workers.get(workerId);
  }

  /** Get all worker info entries */
  getAll(): WorkerInfo[] {
    return Array.from(this.workers.values());
  }

  /** Wait for a specific worker to finish. Returns the info after completion. */
  async waitFor(workerId: string): Promise<WorkerInfo> {
    const info = this.workers.get(workerId);
    if (!info) throw new Error(`Worker not found: ${workerId}`);
    if (info.donePromise) await info.donePromise;
    return info;
  }

  /** Enqueue work if we're at concurrency limit, otherwise execute immediately */
  private dequeuePending() {
    while (this.pending.length > 0 && this.running < MAX_CONCURRENT) {
      const next = this.pending.shift()!;
      next();
    }
  }

  /**
   * Wait in queue if we're at the concurrency limit.
   * Returns immediately if under the limit.
   */
  async waitForSlot(): Promise<void> {
    if (this.running < MAX_CONCURRENT) return;
    return new Promise((resolve) => {
      this.pending.push(resolve);
    });
  }

  /** Clean up all workers. Kills running processes, clears state. */
  destroy() {
    for (const [id, info] of this.workers) {
      this.kill(id);
    }
    this.workers.clear();
    this.pending = [];
  }
}

// Module-level singleton — all AIM extensions share this instance
export const workerPool = new WorkerPool();