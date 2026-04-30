/**
 * Coordinator Mode — Integration Test Suite
 *
 * Tests that coordinator mode actually changes agent behavior.
 * All tests are self-contained — they do NOT import AIM modules directly
 * to avoid dependency resolution issues. Instead, they:
 *   - Validate coordinator prompt structure inline
 *   - Spawn pi processes to test behavioral changes
 *
 * Run: npx tsx test/test-coordinator.ts
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Test Harness
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

// ============================================================================
// Coordinator Prompt Validation (no LLM needed)
// ============================================================================

/**
 * Build coordinator prompt — same logic as coordinator.ts but self-contained.
 * This validates the prompt design without importing AIM modules.
 */
function buildCoordinatorPrompt(agentList: string): string {
  return `## Coordinator Mode — ACTIVE (Highest Priority)

You are a COORDINATOR operating in multi-agent mode. Your PRIMARY responsibility
is to ORCHESTRATE work across subagents using the **subagent** tool. You MUST
delegate, not do the work yourself.

### Available Agents

${agentList}

### Mandatory Workflow — FOLLOW STRICTLY

For any task that requires file reading, code exploration, implementation, or
verification, you MUST follow this workflow:

1. **Research** → ALWAYS use parallel subagents. Split independent questions
   across agents.
2. **Synthesis** → After workers return results, YOU synthesize findings.
   NEVER write code before workers have reported back.
3. **Implementation** → Delegate to workers with SPECIFIC instructions.
4. **Verification** → Delegate to a worker to confirm changes work.

### Rules — YOU MUST OBEY ALL

1. **NEVER** perform file reads, code edits, or bash commands directly.
   Always delegate to subagents.
2. **ALWAYS** launch independent research tasks in PARALLEL (tasks array).
3. After launching workers, state what you launched and END your response.
4. **NEVER** predict or fabricate worker results.
5. When workers report, SYNTHESIZE findings before the next step.

### Example

User: "find and fix auth bugs in the project"

CORRECT (coordinator response):
"I'll research auth bugs by launching parallel scouts."

WRONG:
"I'll read the files myself..." (you are a coordinator, delegate!)

### Task Completion

When all tasks are done, synthesize a final report for the user.`;
}

// ============================================================================
// RPC Worker Helpers
// ============================================================================

function spawnRpcWorker(cwd: string, model?: string): {
  proc: ReturnType<typeof spawn>;
  send(obj: Record<string, unknown>): void;
  waitForEvent(eventType: string, timeoutMs?: number): Promise<Record<string, unknown> | null>;
  stop(): void;
} {
  const args: string[] = [
    "--mode", "rpc",
    "--no-session",
    "--no-tools",
    "--thinking", "off",
    "--model", model ?? "ksyun/deepseek-v3.2",
  ];

  const piCmd = process.platform === "win32"
    ? ["cmd", "/c", "pi.cmd"]
    : ["pi"];

  const proc = spawn(piCmd[0], [...piCmd.slice(1), ...args], {
    cwd, stdio: ["pipe", "pipe", "pipe"],
  });

  const pending: Array<{ eventType: string; resolve: (v: Record<string, unknown> | null) => void; deadline: number }> = [];
  let stopped = false;

  proc.stdin?.on("error", () => {});
  proc.stderr?.on("data", () => {});
  proc.on("error", () => { stopped = true; });
  proc.on("exit", () => { stopped = true; });
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
      } catch {}
    }
  });

  return {
    proc,
    send(obj: Record<string, unknown>) {
      try { if (!stopped && !proc.stdin?.destroyed) proc.stdin.write(JSON.stringify(obj) + "\n"); } catch {}
    },
    waitForEvent(eventType: string, timeoutMs = 30000): Promise<Record<string, unknown> | null> {
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolve) => {
        const entry = { eventType, resolve, deadline };
        pending.push(entry);
        const interval = setInterval(() => {
          if (stopped) { clearInterval(interval); resolve(null); return; }
          if (pending.indexOf(entry) === -1) { clearInterval(interval); return; }
          if (Date.now() > deadline) {
            const idx = pending.indexOf(entry);
            if (idx >= 0) pending.splice(idx, 1);
            clearInterval(interval);
            resolve(null);
          }
        }, 200);
      });
    },
    stop() { stopped = true; },
  };
}

function getAssistantText(messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>): string {
  const assistantMsgs = messages.filter(m => m.role === "assistant");
  if (assistantMsgs.length === 0) return "";
  return assistantMsgs[assistantMsgs.length - 1]?.content
    .filter(p => p.type === "text")
    .map(p => p.text || "")
    .join("") || "";
}

// ============================================================================
// Test 1: coordinator prompt structure validation (no LLM)
// ============================================================================

async function test1_promptStructure() {
  console.log("\n=== Test 1: coordinator prompt structure validation ===");

  const agentList = `- **scout** (user): Reads and searches code files
- **fixer** (user): Makes code changes and edits
- **reviewer** (user): Reviews code for best practices`;

  const prompt = buildCoordinatorPrompt(agentList);

  assert(prompt.length > 200, "prompt has substantial content", `length: ${prompt.length}`);

  // Key structural elements
  const required = [
    { name: "mode header", value: "Coordinator Mode" },
    { name: "COORDINATOR keyword", value: "COORDINATOR" },
    { name: "MUST directive", value: "MUST" },
    { name: "NEVER directive", value: "NEVER" },
    { name: "ALWAYS directive", value: "ALWAYS" },
    { name: "subagent tool", value: "subagent" },
    { name: "parallel mode", value: "parallel" },
    { name: "agent listing", value: "Available Agents" },
    { name: "workflow section", value: "Workflow" },
    { name: "rules section", value: "Rules" },
    { name: "example section", value: "Example" },
    { name: "correct example", value: "CORRECT" },
    { name: "wrong example", value: "WRONG" },
    { name: "delegate keyword", value: "delegate" },
    { name: "synthesize keyword", value: "SYNTHESIZE" },
    { name: "specific agents listed", value: "scout" },
    { name: "specific agents listed", value: "fixer" },
    { name: "specific agents listed", value: "reviewer" },
    { name: "task completion section", value: "Task Completion" },
    { name: "report instruction", value: "final report" },
  ];

  for (const el of required) {
    assert(
      prompt.includes(el.value),
      `has: ${el.name}`,
      `searching for "${el.value}"`
    );
  }

  // Negative checks: coordinator prompt should NOT say things a coder prompt would
  const forbidden = [
    "read the file yourself",
    "write the code",
    "implement directly",
  ];
  for (const f of forbidden) {
    assert(
      !prompt.toLowerCase().includes(f),
      `does NOT contain forbidden phrase: "${f}"`,
      ""
    );
  }

  log("prompt", `prompt validated: ${required.length} elements present, ${forbidden.length} forbidden absent`);
}

// ============================================================================
// Test 2: coordinator delegates (behavioral test with LLM)
// ============================================================================

async function test2_coordinatorDelegates(cwd: string) {
  console.log("\n=== Test 2: coordinator delegates instead of doing work directly ===");

  const agentList = `- **scout** (user): Reads and searches code files
- **fixer** (user): Makes code changes and edits`;
  const coordinatorPrompt = buildCoordinatorPrompt(agentList);

  const worker = spawnRpcWorker(cwd);
  const { proc, send, waitForEvent } = worker;

  try {
    send({
      type: "prompt",
      message: coordinatorPrompt + "\n\n---\n\nUSER REQUEST: There are some authentication bugs in the project. Find and fix them."
    });

    const result = await waitForEvent("agent_end", 60000);
    assert(result !== null, "coordinator produced response", "");

    if (result) {
      const msgs = result.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      const text = getAssistantText(msgs);

      log("output", text.slice(0, 200));

      // Must reference delegation mechanism
      const hasDelegationRef =
        text.toLowerCase().includes("subagent") ||
        text.toLowerCase().includes("scout") ||
        text.toLowerCase().includes("agent") ||
        text.toLowerCase().includes("delegate") ||
        text.toLowerCase().includes("spawn") ||
        text.toLowerCase().includes("worker");

      // Must NOT say it will do work directly
      const hasDirectRead =
        text.toLowerCase().includes("i will read") ||
        text.toLowerCase().includes("i'll read") ||
        text.toLowerCase().includes("let me read") ||
        text.toLowerCase().includes("i'll look");

      assert(hasDelegationRef, "coordinator references delegation mechanism", text.slice(0, 100));
      assert(!hasDirectRead, "coordinator does NOT say it will read directly", text.slice(0, 100));

      // Check: no tool calls (since --no-tools, this is guaranteed, but still verify)
      const assistantMsgs = msgs.filter(m => m.role === "assistant");
      const toolCalls = assistantMsgs.flatMap(m =>
        m.content.filter((p: any) => p.type === "toolCall")
      );
      assert(toolCalls.length === 0, "no tool calls emitted", "");
    }
  } finally {
    try { proc.kill(); } catch {}
  }
}

// ============================================================================
// Test 3: coordinator uses parallel mode for independent tasks
// ============================================================================

async function test3_coordinatorParallel(cwd: string) {
  console.log("\n=== Test 3: coordinator suggests parallel for independent tasks ===");

  const agentList = `- **scout** (user): Reads and searches code files
- **reviewer** (user): Reviews code for best practices`;
  const coordinatorPrompt = buildCoordinatorPrompt(agentList);

  const worker = spawnRpcWorker(cwd);
  const { proc, send, waitForEvent } = worker;

  try {
    send({
      type: "prompt",
      message: coordinatorPrompt + "\n\n---\n\nUSER REQUEST: Research the authentication module AND the database layer. They are independent — no dependencies between them."
    });

    const result = await waitForEvent("agent_end", 60000);
    assert(result !== null, "coordinator produced response", "");

    if (result) {
      const msgs = result.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      const text = getAssistantText(msgs);

      log("output", text.slice(0, 200));

      // Must mention parallel/concurrent/simultaneous
      const mentionsParallel =
        text.toLowerCase().includes("parallel") ||
        text.toLowerCase().includes("concurrent") ||
        text.toLowerCase().includes("simultaneous") ||
        text.toLowerCase().includes("at the same time");

      // Must mention both tasks
      const mentionsBoth =
        text.toLowerCase().includes("auth") &&
        text.toLowerCase().includes("database");

      assert(mentionsParallel, "coordinator mentions parallel execution", text.slice(0, 100));
      assert(mentionsBoth, "coordinator addresses both independent tasks", text.slice(0, 100));
    }
  } finally {
    try { proc.kill(); } catch {}
  }
}

// ============================================================================
// Test 4: non-coordinator vs coordinator behavior comparison
// ============================================================================

async function test4_baselineVsCoordinator(cwd: string) {
  console.log("\n=== Test 4: baseline vs coordinator behavior comparison ===");

  const agentList = `- **scout** (user): Reads and searches code files
- **fixer** (user): Makes code changes`;

  // Baseline: plain coding assistant prompt
  const baselinePrompt = `You are a coding assistant. Help users with their questions directly.`;
  const baseline = spawnRpcWorker(cwd);

  // Coordinator prompt
  const coordinatorPrompt = buildCoordinatorPrompt(agentList);
  const coord = spawnRpcWorker(cwd);

  try {
    const task = "Find out if there are any authentication-related files in the project.";

    // Run both in parallel
    baseline.send({ type: "prompt", message: baselinePrompt + "\n\n---\n\n" + task });
    coord.send({ type: "prompt", message: coordinatorPrompt + "\n\n---\n\n" + task });

    const [baseResult, coordResult] = await Promise.all([
      baseline.waitForEvent("agent_end", 60000),
      coord.waitForEvent("agent_end", 60000),
    ]);

    assert(baseResult !== null, "baseline produced response", "");
    assert(coordResult !== null, "coordinator produced response", "");

    if (baseResult && coordResult) {
      const baseMsgs = baseResult.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      const coordMsgs = coordResult.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      const baseText = getAssistantText(baseMsgs);
      const coordText = getAssistantText(coordMsgs);

      log("baseline", baseText.slice(0, 150));
      log("coordinator", coordText.slice(0, 150));

      // Coordinator must mention delegation
      const coordMentionsDelegation =
        coordText.toLowerCase().includes("subagent") ||
        coordText.toLowerCase().includes("scout") ||
        coordText.toLowerCase().includes("agent") ||
        coordText.toLowerCase().includes("delegate") ||
        coordText.toLowerCase().includes("spawn") ||
        coordText.toLowerCase().includes("worker");

      // Baseline likely says "I will read" or "let me check"
      const baseIsDirect =
        baseText.toLowerCase().includes("i will") ||
        baseText.toLowerCase().includes("i'll") ||
        baseText.toLowerCase().includes("let me") ||
        baseText.toLowerCase().includes("i can");

      assert(coordMentionsDelegation, "coordinator mentions delegation", coordText.slice(0, 100));
      assert(baseIsDirect, "baseline responds directly (first-person)", baseText.slice(0, 100));

      // They should produce different outputs
      assert(baseText !== coordText, "baseline and coordinator produce DIFFERENT outputs", "");
    }
  } finally {
    try { baseline.proc.kill(); } catch {}
    try { coord.proc.kill(); } catch {}
  }
}

// ============================================================================
// Test 5: coordinator prompt injection position matters
// ============================================================================

async function test5_promptPosition() {
  console.log("\n=== Test 5: coordinator prompt positioned at beginning ===");

  const agentList = "- **scout** (user): Reads code";
  const coordinatorPrompt = buildCoordinatorPrompt(agentList);
  const longTrailingPrompt = "A".repeat(5000) + "\n\nYou are also a helpful coding assistant. Be direct.";

  // Case A: coordinator FIRST (correct)
  const promptA = coordinatorPrompt + "\n\n" + longTrailingPrompt;

  // Case B: coordinator LAST (old behavior, incorrect — lost in middle)
  const promptB = longTrailingPrompt + "\n\n" + coordinatorPrompt;

  // Validate: in case A, coordinator content is in the first 500 chars
  const first500ofA = promptA.slice(0, 500);
  assert(
    first500ofA.includes("Coordinator Mode"),
    "coordinator content near beginning (correct position)",
    ""
  );

  // For case B, coordinator is deep in the context — risk of being ignored
  const coordinatorStartInB = promptB.indexOf("Coordinator Mode");
  assert(
    coordinatorStartInB > 5000,
    "coordinator at END when appended (old behavior, problematic)",
    `position: ${coordinatorStartInB}`
  );

  // Validate the new design: coordinator MUST be at the front
  const promptHasCoordinationAtStart =
    coordinatorPrompt.includes("Coordinator Mode") &&
    coordinatorPrompt.indexOf("Coordinator Mode") < 100;

  assert(
    promptHasCoordinationAtStart,
    "coordinator prompt announces mode early",
    `found at offset: ${coordinatorPrompt.indexOf("Coordinator Mode")}`
  );

  log("position", `coordinator at beginning = ${coordinatorStartInB > 5000 ? "better than end" : "at beginning"}`);
}

// ============================================================================
// Test 6: coordinator with empty agent list handles gracefully
// ============================================================================

async function test6_emptyAgentList(cwd: string) {
  console.log("\n=== Test 6: coordinator with empty agent list ===");

  const coordinatorPrompt = buildCoordinatorPrompt("(no agents configured — set up agents in ~/.pi/agent/agents/)");

  const worker = spawnRpcWorker(cwd);
  const { proc, send, waitForEvent } = worker;

  try {
    send({
      type: "prompt",
      message: coordinatorPrompt + "\n\n---\n\nUSER REQUEST:dispatch Find authentication bugs."
    });

    const result = await waitForEvent("agent_end", 30000);
    assert(result !== null, "coordinator with empty agents still responds", "");

    if (result) {
      const msgs = result.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      const text = getAssistantText(msgs);
      log("output", text.slice(0, 200));

      // Should still mention delegation/subagents even without specific agents
      const mentionsDelegation =
        text.toLowerCase().includes("subagent") ||
        text.toLowerCase().includes("agent") ||
        text.toLowerCase().includes("delegate");

      assert(mentionsDelegation, "still mentions delegation concept", text.slice(0, 100));
    }
  } finally {
    try { proc.kill(); } catch {}
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const cwd = process.cwd();
  console.log("AIM Coordinator Mode — Integration Test Suite");
  console.log(`CWD: ${cwd}`);
  console.log("===============================================");
  console.log("Note: Tests 2-4, 6 require active LLM API access (ksyun/deepseek-v3.2)\n");

  const startTime = Date.now();

  // No-LLM tests: prompt structure validation
  await test1_promptStructure();
  await test5_promptPosition();

  // LLM tests: behavioral validation
  await test2_coordinatorDelegates(cwd);
  await test3_coordinatorParallel(cwd);
  await test4_baselineVsCoordinator(cwd);
  await test6_emptyAgentList(cwd);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n===============================================");
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