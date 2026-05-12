/**
 * Worktree Integration — Test Suite (TDD: expects FAILURE on first run)
 *
 * Tests that the subagent tool (via agent-executor.ts) automatically wraps agent
 * execution in a Git worktree. This is the "real integration" test —
 * it exercises the actual executeAgent() code path from agent-executor.ts,
 * NOT a standalone worktree helper.
 *
 * Tests that SHOULD FAIL before implementation:
 *   1. Single subagent creates file in worktree, main dir unchanged (LLM)
 *   2. Parallel subagents each get independent worktrees (LLM)
 *
 * After implementation, these tests verify:
 *   - subagent writes are isolated from parent cwd
 *   - concurrent agents don't cross-contaminate
 *   - worktrees are cleaned up after agent completion
 *
 * Run: npx tsx test/test-worktree-integration.ts
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

// ============================================================================
// Helpers
// ============================================================================

let testCount = 0;
let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function assert(condition: boolean, test: string, detail: string) {
  if (condition) { passCount++; }
  else { failCount++; failures.push(`${test}: ${detail}`); }
  testCount++;
}

function log(phase: string, msg: string) {
  console.log(`  [${phase}] ${msg}`);
}

/** Spawn pi in RPC mode with AIM extension loaded, at a specific cwd */
function spawnCoordinatorWorker(cwd: string): {
  proc: ReturnType<typeof spawn>;
  send(obj: Record<string, unknown>): void;
  waitForEvent(eventType: string, timeoutMs?: number): Promise<Record<string, unknown> | null>;
  stop(): void;
} {
  // Load AIM extension so the subagent tool is available
  const args: string[] = [
    "--mode", "rpc",
    "--no-session",
    "--model", "ksyun/deepseek-v3.2",
    "-e", "../aim/index.ts",
  ];
  const piCmd = process.platform === "win32"
    ? ["cmd", "/c", "pi.cmd"]
    : ["pi"];
  const proc = spawn(piCmd[0], [...piCmd.slice(1), ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending: Array<{ eventType: string; resolve: (v: Record<string, unknown> | null) => void; deadline: number }> = [];
  let stopped = false;

  proc.stdout?.on("data", (data: Buffer) => {
    if (stopped) return;
    for (const line of data.toString().split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        for (let i = pending.length - 1; i >= 0; i--) {
          if (pending[i].eventType === e.type) {
            pending.splice(i, 1)[0].resolve(e);
            return;
          }
        }
      } catch { /* skip non-JSON */ }
    }
  });

  proc.stderr?.on("data", () => {});

  return {
    proc,
    send(obj: Record<string, unknown>) {
      if (!proc.stdin?.destroyed) proc.stdin.write(JSON.stringify(obj) + "\n");
    },
    waitForEvent(eventType: string, timeoutMs = 60000): Promise<Record<string, unknown> | null> {
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolve) => {
        const entry = { eventType, resolve, deadline };
        pending.push(entry);
        const interval = setInterval(() => {
          if (stopped) { clearInterval(interval); resolve(null); return; }
          if (pending.indexOf(entry) === -1) { clearInterval(interval); return; }
          if (Date.now() > deadline) {
            pending.splice(pending.indexOf(entry), 1);
            clearInterval(interval);
            resolve(null);
          }
        }, 200);
      });
    },
    stop() { stopped = true; },
  };
}

// ============================================================================
// Test Cases
// ============================================================================

async function test1_singleSubagentIsolation(cwd: string) {
  console.log("\n=== Test 1: Single subagent creates file — main dir unchanged ===");
  const markerFile = "subagent-output-" + randomUUID().slice(0, 8) + ".txt";

  const coord = spawnCoordinatorWorker(cwd);
  const { proc, send, waitForEvent } = coord;

  try {
    // Phase 1: Use coordinator to dispatch a subagent that creates a file
    // The subagent should run in a worktree, so the file should NOT appear in cwd
    send({
      type: "prompt",
      message: `Use the subagent tool to dispatch a scout agent. Tell it: "use the write tool to create a file named '${markerFile}' with content 'subagent-isolation-test'. Only create the file and report what you did. Do not edit any existing files." Use a single subagent call, not parallel.`,
    });

    const agentEnd = await waitForEvent("agent_end", 120000);
    assert(agentEnd !== null, "coordinator completed", "agent_end received");

    if (agentEnd) {
      const messages = agentEnd.messages as Array<{
        role: string;
        content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
      }> | undefined;

      // Check that the coordinator actually called the subagent tool
      const toolCalls = messages?.flatMap(m =>
        m.content.filter(c => c.type === "toolCall" && c.name === "subagent")
      ) ?? [];
      assert(toolCalls.length >= 1, "coordinator used subagent tool", `tool calls: ${toolCalls.length}`);
      log("dispatch", `coordinator made ${toolCalls.length} subagent call(s)`);
    }

    // THE KEY ASSERTION: file should NOT be in the main working directory
    // (because subagent should run in a worktree)
    const fileInMain = fs.existsSync(path.join(cwd, markerFile));
    assert(!fileInMain, "marker file NOT in main cwd", "isolation verified — worktree used");

    // Check if any worktree directories were created (and cleaned up)
    const aimDir = path.join(cwd, ".pi", "aim");
    if (fs.existsSync(aimDir)) {
      const contents = fs.readdirSync(aimDir).filter(f => f.startsWith("test-worktree"));
      log("worktree", `remaining worktree dirs: ${contents.length > 0 ? contents.join(", ") : "none (all cleaned up)"}`);
      assert(contents.length === 0, "worktrees cleaned up after subagent", `found: ${contents.join(", ")}`);
    }

  } finally {
    proc.kill();
    // Clean up marker file if it somehow ended up in main dir
    try { if (fs.existsSync(path.join(cwd, markerFile))) fs.unlinkSync(path.join(cwd, markerFile)); } catch {}
    // Clean up any stale worktrees
    try {
      const list = execSync("git worktree list", { cwd, encoding: "utf-8" });
      for (const line of list.split("\n")) {
        if (line.includes(".pi/aim/test-worktree") || line.includes(".pi/aim/agent-")) {
          const wtPath = line.trim().split(/\s+/)[0];
          if (wtPath) {
            execSync(`git worktree remove --force ${wtPath.replace(/\\/g, "/")}`, { cwd, stdio: "pipe" });
          }
        }
      }
    } catch {}
  }
}

async function test2_parallelSubagentsIsolation(cwd: string) {
  console.log("\n=== Test 2: Parallel subagents each get independent worktrees ===");
  const markerA = "parallel-A-" + randomUUID().slice(0, 8) + ".txt";
  const markerB = "parallel-B-" + randomUUID().slice(0, 8) + ".txt";

  const coord = spawnCoordinatorWorker(cwd);
  const { proc, send, waitForEvent } = coord;

  try {
    // Dispatch TWO parallel subagents, each creating a different file
    send({
      type: "prompt",
      message: `Use the subagent tool with parallel tasks to dispatch TWO scouts simultaneously:
1. Scout A: "use write tool to create file '${markerA}' with content 'parallel-agent-A-output'. Only create the file and report."
2. Scout B: "use write tool to create file '${markerB}' with content 'parallel-agent-B-output'. Only create the file and report."
Use tasks array format — both in one subagent call.`,
    });

    const agentEnd = await waitForEvent("agent_end", 120000);
    assert(agentEnd !== null, "coordinator completed parallel dispatch", "agent_end received");

    if (agentEnd) {
      const messages = agentEnd.messages as Array<{
        role: string;
        content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
      }> | undefined;

      const subagentCalls = messages?.flatMap(m =>
        m.content.filter(c => c.type === "toolCall" && c.name === "subagent")
      ) ?? [];
      assert(subagentCalls.length >= 1, "coordinator called subagent tool", `calls: ${subagentCalls.length}`);

      // Check if tasks array was used (parallel mode)
      const hasParallelTasks = subagentCalls.some(c =>
        c.input && (c.input as Record<string, unknown>).tasks !== undefined
      );
      log("dispatch", `parallel tasks used: ${hasParallelTasks}`);
    }

    // KEY ASSERTIONS: neither file should be in main cwd
    assert(!fs.existsSync(path.join(cwd, markerA)), "marker A NOT in main cwd", "agent A isolated");
    assert(!fs.existsSync(path.join(cwd, markerB)), "marker B NOT in main cwd", "agent B isolated");

    // Worktrees should be cleaned up
    const aimDir = path.join(cwd, ".pi", "aim");
    if (fs.existsSync(aimDir)) {
      const staleWts = fs.readdirSync(aimDir).filter(f =>
        f.startsWith("test-worktree") || f.startsWith("agent-")
      );
      log("worktree", `remaining worktree dirs: ${staleWts.length > 0 ? staleWts.join(", ") : "none (all cleaned up)"}`);
      assert(staleWts.length === 0, "all worktrees cleaned up after parallel agents", `found: ${staleWts.join(", ")}`);
    }

  } finally {
    proc.kill();
    try { if (fs.existsSync(path.join(cwd, markerA))) fs.unlinkSync(path.join(cwd, markerA)); } catch {}
    try { if (fs.existsSync(path.join(cwd, markerB))) fs.unlinkSync(path.join(cwd, markerB)); } catch {}
    try {
      const list = execSync("git worktree list", { cwd, encoding: "utf-8" });
      for (const line of list.split("\n")) {
        if (line.includes(".pi/aim/")) {
          const wtPath = line.trim().split(/\s+/)[0];
          if (wtPath) {
            execSync(`git worktree remove --force ${wtPath.replace(/\\/g, "/")}`, { cwd, stdio: "pipe" });
          }
        }
      }
    } catch {}
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const cwd = process.cwd();
  console.log("AIM Worktree Integration — Test Suite (TDD: expects FAILURE)");
  console.log(`CWD: ${cwd}`);
  console.log("===========================================");

  const startTime = Date.now();

  await test1_singleSubagentIsolation(cwd);
  await test2_parallelSubagentsIsolation(cwd);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n===========================================");
  console.log(`Results: ${passCount}/${testCount} passed, ${failCount} failed (${elapsed}s)`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  } else {
    console.log("All tests passed!");
    process.exit(0);
  }
}

main().catch(err => {
  console.error("Test suite crashed:", err);
  process.exit(2);
});