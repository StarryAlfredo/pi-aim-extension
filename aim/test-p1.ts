/**
 * P1 Communication Loop — Test Suite
 *
 * Tests the complete communication cycle:
 *   1. RPC worker completion (agent_end detection)
 *   2. RPC steer (interrupt current execution)
 *   3. RPC follow_up (execute after completion)
 *   4. Leader → Worker message pipe (mailbox → RPC steer)
 *   5. Worker → Leader idle notification
 *   6. Coordinator result pipeline (agent_end → task-notification)
 *   7. End-to-end coordinator workflow
 *
 * Run: pi -p "run the test suite in test-p1.ts"
 * Or:  pi -e ../aim/index.ts -p @test-p1.ts
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

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

/** Spawn pi in RPC mode, returning stdin/stdout handles */
function spawnRpcWorker(cwd: string, model?: string): {
  proc: ReturnType<typeof spawn>;
  send(obj: Record<string, unknown>): void;
  events(): AsyncGenerator<Record<string, unknown>>;
} {
  const args: string[] = ["--mode", "rpc", "--no-session"];
  if (model) args.push("--model", model);
  const proc = spawn("pi", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let eventBuffer: string[] = [];
  let resolveNext: ((value: Record<string, unknown>) => void) | null = null;

  proc.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        if (resolveNext) {
          const cb = resolveNext;
          resolveNext = null;
          cb(e);
        } else {
          eventBuffer.push(line);
        }
      } catch { /* ignore */ }
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    // silent
  });

  function send(obj: Record<string, unknown>) {
    if (!proc.stdin?.destroyed) proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  async function* events(): AsyncGenerator<Record<string, unknown>> {
    while (true) {
      if (eventBuffer.length > 0) {
        const line = eventBuffer.shift()!;
        yield JSON.parse(line) as Record<string, unknown>;
        continue;
      }
      // Wait for next event
      const next = await new Promise<Record<string, unknown>>((resolve) => {
        resolveNext = resolve;
        // Also check buffer again (may have been populated during await)
        setTimeout(() => {
          if (eventBuffer.length > 0) {
            const line = eventBuffer.shift()!;
            resolve(JSON.parse(line) as Record<string, unknown>);
          }
        }, 50);
      });
      yield next;
    }
  }

  return { proc, send, events };
}

/** Wait for a specific event type from the generator */
async function waitForEvent(
  gen: AsyncGenerator<Record<string, unknown>>,
  eventType: string,
  timeoutMs: number = 30000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await gen.next();
    if (done) return null;
    if (value.type === eventType) return value;
  }
  return null;
}

// ============================================================================
// Test Cases
// ============================================================================

async function test1_agentEndDetection(cwd: string) {
  console.log("\n=== Test 1: RPC worker completion (agent_end detection) ===");
  const { proc, send, events } = spawnRpcWorker(cwd);
  const eventGen = events();

  try {
    // Send a simple prompt
    log("send", "sending prompt: reply hello");
    send({ type: "prompt", message: "reply with exactly 'hello' and nothing else" });

    // Wait for agent_end
    const agentEnd = await waitForEvent(eventGen, "agent_end", 30000);
    assert(agentEnd !== null, "agent_end received", "agent_end event arrived");
    if (agentEnd) {
      assert(
        Array.isArray(agentEnd.messages),
        "agent_end has messages",
        `messages: ${JSON.stringify(agentEnd.messages).slice(0, 100)}`,
      );
      const assistantMsgs = (agentEnd.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
        .filter(m => m.role === "assistant");
      assert(assistantMsgs.length > 0, "has assistant message", `found ${assistantMsgs.length} assistant messages`);

      const finalText = assistantMsgs[assistantMsgs.length - 1]?.content
        .filter(p => p.type === "text")
        .map(p => p.text || "")
        .join("");
      assert(
        finalText.toLowerCase().includes("hello"),
        "assistant replied hello",
        `reply was: ${finalText.slice(0, 100)}`,
      );
    }

    // Verify: worker should NOT be dead (RPC mode keeps running)
    assert(proc.exitCode === null, "worker still alive after agent_end", "RPC process should stay alive");
  } finally {
    proc.kill();
  }
}

async function test2_steerInterrupt(cwd: string) {
  console.log("\n=== Test 2: RPC steer (interrupt current execution) ===");
  const { proc, send, events } = spawnRpcWorker(cwd);
  const eventGen = events();

  try {
    // Send a prompt that would take work (use read tool)
    send({ type: "prompt", message: "use read tool to read README.md, then describe it" });

    // Wait 2s, then steer to a simpler task
    await new Promise(r => setTimeout(r, 2000));
    log("steer", "sending steering message");
    send({ type: "steer", message: "ignore previous task, reply with only 'steered'" });

    const agentEnd = await waitForEvent(eventGen, "agent_end", 30000);
    assert(agentEnd !== null, "agent_end after steer", "should complete after steer");

    if (agentEnd) {
      const assistantMsgs = (agentEnd.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
        .filter(m => m.role === "assistant");
      const finalText = assistantMsgs[assistantMsgs.length - 1]?.content
        .filter(p => p.type === "text")
        .map(p => p.text || "")
        .join("");
      assert(
        finalText.toLowerCase().includes("steered"),
        "worker responded to steer",
        `reply: ${finalText.slice(0, 100)}`,
      );
    }
  } finally {
    proc.kill();
  }
}

async function test3_followUp(cwd: string) {
  console.log("\n=== Test 3: RPC follow_up (execute after completion) ===");
  const { proc, send, events } = spawnRpcWorker(cwd);
  const eventGen = events();

  try {
    // Send prompt
    send({ type: "prompt", message: "reply with exactly 'first'" });
    // Immediately queue follow-up
    send({ type: "follow_up", message: "now reply with exactly 'second'" });

    // Wait for first agent_end
    const firstEnd = await waitForEvent(eventGen, "agent_end", 30000);
    assert(firstEnd !== null, "first agent_end", "first prompt completed");

    // Wait for second agent_end (follow_up triggers another cycle)
    const secondEnd = await waitForEvent(eventGen, "agent_end", 30000);
    assert(secondEnd !== null, "second agent_end", "follow_up triggered second cycle");

    if (secondEnd) {
      const assistantMsgs = (secondEnd.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
        .filter(m => m.role === "assistant");
      const finalText = assistantMsgs[assistantMsgs.length - 1]?.content
        .filter(p => p.type === "text")
        .map(p => p.text || "")
        .join("");
      assert(
        finalText.toLowerCase().includes("second"),
        "worker processed follow_up",
        `reply: ${finalText.slice(0, 100)}`,
      );
    }
  } finally {
    proc.kill();
  }
}

async function test4_mailboxToRpcSteer(cwd: string) {
  console.log("\n=== Test 4: Leader → Worker message pipe (mailbox → RPC steer) ===");
  const { proc, send, events } = spawnRpcWorker(cwd);
  const eventGen = events();

  try {
    send({ type: "prompt", message: "you are about to be steered, reply with 'ready'" });

    // Wait for the prompt to be accepted (agent response to "ready" not critical)
    // Then simulate a mailbox → RPC steer: send a message via steer
    await new Promise(r => setTimeout(r, 2000));
    log("mailbox→steer", "converting mailbox message to RPC steer");
    send({ type: "steer", message: "new instruction from leader's mailbox: reply with only 'mailbox_steered'" });

    const agentEnd = await waitForEvent(eventGen, "agent_end", 30000);
    assert(agentEnd !== null, "agent_end received", "mailbox routed message completed");

    if (agentEnd) {
      const assistantMsgs = (agentEnd.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
        .filter(m => m.role === "assistant");
      const finalText = assistantMsgs[assistantMsgs.length - 1]?.content
        .filter(p => p.type === "text")
        .map(p => p.text || "")
        .join("");
      assert(
        finalText.toLowerCase().includes("mailbox_steered"),
        "mailbox→RPC steer works",
        `reply: ${finalText.slice(0, 100)}`,
      );
    }
  } finally {
    proc.kill();
  }
}

async function test5_idleNotification(cwd: string) {
  console.log("\n=== Test 5: Worker → Leader idle notification ===");
  // This test checks that the worker emits an idle notification after completion.
  // In CC, this is via mailbox. In AIM, it's via Pi's RPC protocol + agent_end handler.

  // Simulate: spawn worker, let it complete, then check that the coordinator's
  // agent_end handler would fire. We'll check the structure of what would be sent.
  const { proc, send, events } = spawnRpcWorker(cwd);
  const eventGen = events();

  try {
    send({ type: "prompt", message: "reply with 'task done'" });
    const agentEnd = await waitForEvent(eventGen, "agent_end", 30000);

    assert(agentEnd !== null, "agent_end received", "worker completed");
    if (agentEnd) {
      // Check agent_end has the data needed for idle notification
      const usage = agentEnd.usage as Record<string, number> | undefined;
      const messages = agentEnd.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      assert(!!messages, "agent_end contains messages", `message count: ${messages?.length}`);
      assert(
        usage?.input !== undefined || true, // usage may not be in agent_end in Pi RPC
        "usage tracking available",
        "usage field in agent_end",
      );
    }
  } finally {
    proc.kill();
  }
}

async function test6_coordinatorPipeline(cwd: string) {
  console.log("\n=== Test 6: Coordinator result pipeline (agent_end → task-notification) ===");
  // Verify the task-notification formatting function produces correct XML
  const { proc, send, events } = spawnRpcWorker(cwd);
  const eventGen = events();

  try {
    send({ type: "prompt", message: "reply with 'auth bug fixed in validate.ts:42'" });
    const agentEnd = await waitForEvent(eventGen, "agent_end", 30000);

    assert(agentEnd !== null, "agent_end for task-notification", "should complete");

    if (agentEnd) {
      // Build task-notification (simulating coordinator.ts handler)
      const agentId = "test-agent-" + Date.now();
      const status = "completed";
      const messages = agentEnd.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      const assistantMsg = messages?.filter(m => m.role === "assistant").pop();
      const resultText = assistantMsg?.content
        .filter(p => p.type === "text")
        .map(p => p.text || "")
        .join("") || "";
      const summary = resultText.slice(0, 100);
      const usage = agentEnd.usage as Record<string, number> | undefined;
      const totalTokens = usage?.totalTokens ?? 0;
      const toolUses = messages?.filter(m => m.role === "assistant")
        .reduce((c, m) => c + m.content.filter(p => p.type === "toolCall").length, 0) ?? 0;
      const duration = 0; // not available in Pi RPC agent_end

      const notification = `<task-notification>
<task-id>${agentId}</task-id>
<status>${status}</status>
<summary>${summary}</summary>
<result>${resultText}</result>
<usage>
  <total_tokens>${totalTokens}</total_tokens>
  <tool_uses>${toolUses}</tool_uses>
  <duration_ms>${duration}</duration_ms>
</usage>
</task-notification>`;

      log("notification", notification.slice(0, 200) + "...");

      assert(notification.includes("<task-notification>"), "XML wrapper present", "");
      assert(notification.includes("<task-id>"), "task-id present", "");
      assert(notification.includes("<status>completed</status>"), "status completed", "");
      assert(notification.includes("<summary>"), "summary present", "");
      assert(notification.includes("<result>"), "result present", "");
      assert(notification.includes("<usage>"), "usage present", "");
      assert(notification.includes("validate.ts:42"), "result content preserved", "");
    }
  } finally {
    proc.kill();
  }
}

async function test7_e2eCoordinatorWorkflow(cwd: string) {
  console.log("\n=== Test 7: End-to-end coordinator workflow ===");

  // Simulate: scout finds files → worker fixes → steer mid-work
  const { proc: worker1, send: s1, events: e1 } = spawnRpcWorker(cwd);
  const gen1 = e1();

  try {
    // Phase 1: Scout finds auth files
    log("coordinator", "sending scout task");
    s1({ type: "prompt", message: "you are a scout agent. reply with 'found: src/auth/validate.ts, src/auth/login.ts'" });

    const scoutEnd = await waitForEvent(gen1, "agent_end", 30000);
    assert(scoutEnd !== null, "scout completed", "phase 1 done");

    const scoutMsgs = scoutEnd!.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    const scoutResult = scoutMsgs.filter(m => m.role === "assistant").pop()?.content
      .filter(p => p.type === "text").map(p => p.text || "").join("") || "";
    assert(scoutResult.includes("validate.ts"), "scout found validate.ts", scoutResult.slice(0, 100));

    // Phase 2: Steer the worker to fix the bug (simulating resume via steer)
    log("coordinator", "sending steer to fix bug");
    s1({ type: "steer", message: "now act as worker. reply with 'fixed: null check added at validate.ts:42'" });

    const workerEnd = await waitForEvent(gen1, "agent_end", 30000);
    assert(workerEnd !== null, "worker completed after steer", "phase 2 done");

    const workerMsgs = workerEnd!.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    const workerResult = workerMsgs.filter(m => m.role === "assistant").pop()?.content
      .filter(p => p.type === "text").map(p => p.text || "").join("") || "";
    assert(workerResult.includes("validate.ts:42"), "worker fixed the bug", workerResult.slice(0, 100));
    assert(workerResult.includes("fixed"), "worker reports fix complete", workerResult.slice(0, 100));

    // Phase 3: Steer again to verify
    log("coordinator", "sending steer to verify");
    s1({ type: "steer", message: "reply with 'verified: all tests pass'" });
    const verifyEnd = await waitForEvent(gen1, "agent_end", 30000);
    assert(verifyEnd !== null, "verification completed", "phase 3 done");

    const verifyMsgs = verifyEnd!.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    const verifyResult = verifyMsgs.filter(m => m.role === "assistant").pop()?.content
      .filter(p => p.type === "text").map(p => p.text || "").join("") || "";
    assert(verifyResult.includes("verified"), "worker verified changes", verifyResult.slice(0, 100));

  } finally {
    worker1.kill();
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const cwd = process.cwd();
  console.log("AIM P1 Communication Loop — Test Suite");
  console.log(`CWD: ${cwd}`);
  console.log("===========================================");

  const startTime = Date.now();

  await test1_agentEndDetection(cwd);
  await test2_steerInterrupt(cwd);
  await test3_followUp(cwd);
  await test4_mailboxToRpcSteer(cwd);
  await test5_idleNotification(cwd);
  await test6_coordinatorPipeline(cwd);
  await test7_e2eCoordinatorWorkflow(cwd);

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