/**
 * P1 Communication Loop — Test Suite v2
 *
 * Uses simple event collection instead of generator pattern.
 * All events collected into an array; test polls for expected events.
 * Run: npx tsx test-p1.ts
 */

import { spawn } from "node:child_process";
import * as path from "node:path";

let testCount = 0, passCount = 0, failCount = 0;
const failures: string[] = [];

function assert(condition: boolean, test: string, detail: string) {
  testCount++;
  if (condition) passCount++;
  else { failCount++; failures.push(`${test}: ${detail}`); }
}

function log(phase: string, msg: string) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`  [${t}][${phase}] ${msg}`);
}

/** Spawn pi RPC and return a simple interface */
function spawnRpc(cwd: string, model?: string) {
  // Use node + pi script directly (bypasses .cmd wrapper issues)
  const npmDir = path.join(process.env.APPDATA || "", "npm");
  const piScript = path.join(npmDir, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js");
  const nodeExe = process.execPath;

  const args = [piScript, "--mode", "rpc", "--no-session"];
  if (model) args.push("--model", model);

  const proc = spawn(nodeExe, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const events: Record<string, unknown>[] = [];

  proc.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg && !msg.includes("DeprecationWarning")) log("stderr", msg.slice(0, 120));
  });

  proc.stdout?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); }
      catch { /* ignore */ }
    }
  });

  function send(obj: Record<string, unknown>) {
    if (!proc.stdin?.destroyed) proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** Wait for any event with given type */
  async function waitFor(type: string, timeoutMs = 60000): Promise<Record<string, unknown> | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = events.find(e => e.type === type);
      if (found) return found;
      await new Promise(r => setTimeout(r, 200));
    }
    return null;
  }

  function extractResult(ev: Record<string, unknown>): string {
    const msgs = (ev.messages || []) as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    return msgs.filter(m => m.role === "assistant")
      .flatMap(m => m.content.filter(p => p.type === "text"))
      .map(p => p.text || "").join("\n");
  }

  return { proc, send, waitFor, extractResult, events };
}

// ═══ Test Cases ═══

async function t1(cwd: string) {
  console.log("\n=== Test 1: agent_end detection ===");
  const w = spawnRpc(cwd);
  try {
    log("send", "prompt: reply hello");
    w.send({ type: "prompt", message: "reply with exactly 'hello'" });

    const end = await w.waitFor("agent_end", 60000);
    assert(end !== null, "agent_end received", "event arrived");
    if (end) {
      const result = w.extractResult(end);
      assert(result.toLowerCase().includes("hello"), "output has hello", result.slice(0, 80));
      assert(w.proc.exitCode === null, "RPC stays alive", "process not dead after agent_end");
    }
  } finally { w.proc.kill(); }
}

async function t2(cwd: string) {
  console.log("\n=== Test 2: steer interrupt ===");
  const w = spawnRpc(cwd);
  try {
    w.send({ type: "prompt", message: "ls -la the current directory, then use read tool on README.md" });
    await new Promise(r => setTimeout(r, 3000));
    log("steer", "interrupting with new task");
    w.send({ type: "steer", message: "ignore previous, reply only: STEERED_OK" });

    const end = await w.waitFor("agent_end", 60000);
    assert(end !== null, "agent_end after steer", "completed");
    if (end) {
      const r = w.extractResult(end);
      assert(r.toLowerCase().includes("steered"), "responded to steer", r.slice(0, 80));
    }
  } finally { w.proc.kill(); }
}

async function t3(cwd: string) {
  console.log("\n=== Test 3: follow_up ===");
  const w = spawnRpc(cwd);
  try {
    w.send({ type: "prompt", message: "reply exactly: FIRST" });
    w.send({ type: "follow_up", message: "now reply exactly: SECOND" });

    const e1 = await w.waitFor("agent_end", 60000);
    assert(e1 !== null, "first agent_end", "phase 1 done");

    const e2 = await w.waitFor("agent_end", 120000);
    assert(e2 !== null, "second agent_end", "follow_up triggered phase 2");
    if (e2) {
      const r = w.extractResult(e2);
      assert(r.toLowerCase().includes("second"), "output has second", r.slice(0, 80));
    }
  } finally { w.proc.kill(); }
}

async function t4(cwd: string) {
  console.log("\n=== Test 4: mailbox-like RPC steer ===");
  const w = spawnRpc(cwd);
  try {
    w.send({ type: "prompt", message: "reply: READY" });
    await new Promise(r => setTimeout(r, 5000));
    log("steer", "simulating mailbox message via steer");
    w.send({ type: "steer", message: "now reply: MAILBOX_ROUTED" });

    const end = await w.waitFor("agent_end", 60000);
    assert(end !== null, "agent_end received", "routed");
    if (end) {
      const r = w.extractResult(end);
      assert(r.toLowerCase().includes("mailbox"), "routed via steer", r.slice(0, 80));
    }
  } finally { w.proc.kill(); }
}

async function t5(cwd: string) {
  console.log("\n=== Test 5: idle notification data ===");
  const w = spawnRpc(cwd);
  try {
    w.send({ type: "prompt", message: "reply: TASK_DONE" });
    const end = await w.waitFor("agent_end", 60000);
    assert(end !== null, "agent_end received", "completed");
    if (end) {
      assert(!!end.messages, "has messages array", "");
      assert(!!end.usage, "has usage object", JSON.stringify(end.usage).slice(0, 80));
    }
  } finally { w.proc.kill(); }
}

async function t6(cwd: string) {
  console.log("\n=== Test 6: task-notification format ===");
  const w = spawnRpc(cwd);
  try {
    w.send({ type: "prompt", message: "reply: bug fixed in auth.ts:42" });
    const end = await w.waitFor("agent_end", 60000);
    assert(end !== null, "agent_end for notification", "done");
    if (end) {
      const result = w.extractResult(end);
      assert(result.includes("auth.ts"), "result contains file ref", result.slice(0, 80));
    }
  } finally { w.proc.kill(); }
}

async function t7(cwd: string) {
  console.log("\n=== Test 7: coordinator workflow (scout → worker → verify) ===");
  const w = spawnRpc(cwd);
  try {
    // Scout phase
    log("coord", "scout: find auth files");
    w.send({ type: "prompt", message: "reply with exactly: FOUND src/auth/login.ts src/auth/validate.ts" });
    const scoutEnd = await w.waitFor("agent_end", 60000);
    assert(scoutEnd !== null, "scout completed", "");
    const scoutResult = w.extractResult(scoutEnd!);
    assert(scoutResult.includes("validate.ts"), "scout found files", scoutResult.slice(0, 80));

    // Worker phase (steer)
    log("coord", "steer: fix the bug");
    w.send({ type: "steer", message: "reply with exactly: FIXED null check at validate.ts:42" });
    const workerEnd = await w.waitFor("agent_end", 60000);
    assert(workerEnd !== null, "worker fixed", "");
    const workerResult = w.extractResult(workerEnd!);
    assert(workerResult.includes("validate.ts:42"), "fixed at correct location", workerResult.slice(0, 80));

    // Verify phase (steer)
    log("coord", "steer: verify");
    w.send({ type: "steer", message: "reply with exactly: VERIFIED all tests pass" });
    const verifyEnd = await w.waitFor("agent_end", 60000);
    assert(verifyEnd !== null, "verification complete", "");
    const verifyResult = w.extractResult(verifyEnd!);
    assert(verifyResult.toLowerCase().includes("verified"), "verified", verifyResult.slice(0, 80));
  } finally { w.proc.kill(); }
}

// ═══ Main ═══
async function main() {
  const cwd = process.cwd();
  console.log("AIM P1 Communication Loop — Test Suite v2");
  console.log(`CWD: ${cwd}\n`);

  const start = Date.now();

  await t1(cwd);
  await t2(cwd);
  await t3(cwd);
  await t4(cwd);
  await t5(cwd);
  await t6(cwd);
  await t7(cwd);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(55)}`);
  console.log(`Results: ${passCount}/${testCount} passed, ${failCount} failed (${elapsed}s)`);
  if (failCount > 0) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log("All tests passed!");
}

main().catch(err => { console.error("Crash:", err); process.exit(2); });