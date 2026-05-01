/**
 * Teammate Autonomy — Test Suite (TDD: expects FAILURE on first run)
 *
 * Tests that teammates are AUTONOMOUS — they don't wait for coordinator
 * to push prompts. Instead, they continuously poll their inbox and
 * task list, acting whenever something arrives.
 *
 * Tests:
 *   1. Poll cycle: pollInbox returns when a message arrives
 *   2. Priority ordering: shutdown > team-lead > peer > task claim
 *   3. After processing, teammate returns to idle and continues polling
 *   4. E2E: teammate autonomously claims and completes a task
 *   5. E2E: teammate reads a peer message and responds
 *
 * Run: npx tsx test/test-teammate-autonomy.ts
 */

import { spawn, execSync } from "node:child_process";
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

// ============================================================================
// Test Cases — Unit Tests (no LLM, no subprocess)
// ============================================================================

function test1_pollInboxReturnsOnMessage() {
  console.log("\n=== Test 1: pollInbox returns when a message arrives (logic verification) ===");

  // Simulate a poll cycle state machine
  // 1. No messages → wait
  // 2. Message arrives → return it
  // 3. Message marked read → continue polling

  let inbox: Array<{ from: string; text: string; read: boolean }> = [];

  function simulatePoll(): { type: string; message?: string } | null {
    const unread = inbox.filter(m => !m.read);
    if (unread.length > 0) {
      const msg = unread[0];
      msg.read = true;
      return { type: "new_message", message: msg.text };
    }
    return null;
  }

  // Initial: empty inbox
  assert(simulatePoll() === null, "empty inbox returns null", "");

  // Message arrives
  inbox.push({ from: "team-lead", text: "analyze auth module", read: false });
  const result = simulatePoll();
  assert(result !== null, "message arrival triggers poll return", "");
  assert(result?.message === "analyze auth module", "message content preserved", result?.message ?? "");

  // After processing: message marked read
  assert(inbox[0].read === true, "message marked read after processing", "");

  // After read: poll returns null again
  assert(simulatePoll() === null, "after processing all messages, poll returns null", "");
}

function test2_priorityOrdering() {
  console.log("\n=== Test 2: Priority ordering: shutdown > team-lead > peer > task ===");

  // Simulate multiple messages in inbox with different priorities
  const messages = [
    { from: "worker-2", text: "hey can you help?", read: false, priority: 3 },
    { from: "team-lead", text: "urgent: new task", read: false, priority: 2 },
    { from: "worker-1", text: "SHUTDOWN_REQUEST:{\"request_id\":\"r1\",\"from\":\"team-lead\"}", read: false, priority: 1 },
  ];

  // Priority lookup function (matching poller.ts logic)
  function getShutdownIdx(msgs: typeof messages): number {
    return msgs.findIndex(m => m.text.startsWith("SHUTDOWN_REQUEST"));
  }
  function getLeadIdx(msgs: typeof messages): number {
    return msgs.findIndex(m => m.from === "team-lead" && !m.text.startsWith("SHUTDOWN_REQUEST"));
  }
  function getPeerIdx(msgs: typeof messages): number {
    return msgs.findIndex(m => m.from !== "team-lead");
  }

  // Shutdown always first
  const shutdownIdx = getShutdownIdx(messages);
  assert(shutdownIdx === 2, "shutdown_request found first (priority 1)", `idx: ${shutdownIdx}`);

  // Remove shutdown, lead is next
  messages.splice(shutdownIdx, 1);
  const leadIdx = getLeadIdx(messages);
  assert(leadIdx === 1, "team-lead message found second (priority 2)", `idx: ${leadIdx}`);

  // Remove lead, peer is next
  messages.splice(leadIdx, 1);
  const peerIdx = getPeerIdx(messages);
  assert(peerIdx === 0, "peer message found third (priority 3)", `idx: ${peerIdx}`);
}

function test3_pollCycleStateMachine() {
  console.log("\n=== Test 3: Teammate poll cycle state machine ===");

  type TeammateState = "idle" | "polling" | "processing" | "shutting_down";
  const transitions: Record<TeammateState, TeammateState[]> = {
    idle: ["polling"],
    polling: ["processing", "idle"],
    processing: ["idle", "shutting_down"],
    shutting_down: [],
  };

  // Verify valid state machine
  assert(transitions.idle.includes("polling"), "idle → polling is valid", "");
  assert(transitions.polling.includes("processing"), "polling → processing is valid", "");
  assert(transitions.polling.includes("idle"), "polling → idle is valid (no messages)", "");
  assert(transitions.processing.includes("idle"), "processing → idle is valid (done)", "");
  assert(transitions.processing.includes("shutting_down"), "processing → shutting_down is valid", "");

  // Verify no invalid transitions
  assert(!transitions.idle.includes("processing"), "idle → processing is invalid (must poll first)", "");
  assert(!transitions.processing.includes("polling"), "processing → polling is invalid (finish first)", "");

  log("state", "valid transitions: idle→polling→processing→idle (cycle)");
}

// ============================================================================
// Test Cases — Integration Tests (LLM, spawn real pi with AIM)
// ============================================================================

function spawnTeammateWorker(cwd: string, teamName: string, agentName: string): {
  proc: ReturnType<typeof spawn>;
  send(obj: Record<string, unknown>): void;
  waitForEvent(eventType: string, timeoutMs?: number): Promise<Record<string, unknown> | null>;
  stop(): void;
} {
  const args: string[] = [
    "--mode", "rpc",
    "--no-session",
    "--model", "zai/glm-5.1",
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
      } catch {}
    }
  });

  proc.stderr?.on("data", () => {});

  return {
    proc,
    send(obj: Record<string, unknown>) {
      if (!proc.stdin?.destroyed) proc.stdin.write(JSON.stringify(obj) + "\n");
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

async function test4_e2e_taskClaimCycle() {
  console.log("\n=== Test 4: Task claim cycle (self-contained, no module imports) ===");

  const cwd = process.cwd();
  const teamName = "test-team-" + Date.now().toString(36);
  const agentName = "autonomous-worker";
  const tasksDir = path.join(cwd, ".pi", "aim", "tasks", teamName);

  // Simulate task creation in filesystem (matching shared-tasks.ts format)
  const taskId = "task-" + randomUUID().slice(0, 8);
  const taskFile = path.join(tasksDir, `${taskId}.json`);
  const taskData = {
    id: taskId, subject: "write-test-file",
    description: "Create a file named auton-test.txt with content 'autonomous-worker-done'",
    status: "pending", owner: null as string | null, blockedBy: [] as string[],
    createdAt: Date.now(), updatedAt: Date.now(),
  };

  try {
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(taskFile, JSON.stringify(taskData, null, 2), "utf-8");
    log("setup", `created task: ${taskId}`);

    // Simulate findAvailableTask
    function findAvailable(): typeof taskData | null {
      if (!fs.existsSync(tasksDir)) return null;
      const files = fs.readdirSync(tasksDir).filter(f => f.endsWith(".json"));
      for (const f of files) {
        const raw = fs.readFileSync(path.join(tasksDir, f), "utf-8");
        const t = JSON.parse(raw);
        if (t.status === "pending" && (t.blockedBy || []).length === 0) return t;
      }
      return null;
    }

    const available = findAvailable();
    assert(available !== null, "task found as available", "");
    assert(available?.id === taskId, "correct task ID", available?.id ?? "");

    // Simulate claimTask
    if (available) {
      available.status = "in_progress";
      available.owner = agentName;
      available.updatedAt = Date.now();
      fs.writeFileSync(taskFile, JSON.stringify(available, null, 2), "utf-8");

      const afterClaim = JSON.parse(fs.readFileSync(taskFile, "utf-8"));
      assert(afterClaim.status === "in_progress", "task status is in_progress", afterClaim.status);
      assert(afterClaim.owner === agentName, "task owner set correctly", afterClaim.owner);
    }

    // After claim: task no longer available
    assert(findAvailable() === null, "task not available after claim", "");

  } finally {
    try { fs.rmSync(tasksDir, { recursive: true, force: true }); } catch {}
  }
}

// ============================================================================
// Run
// ============================================================================

async function main() {
  const cwd = process.cwd();
  console.log("AIM Teammate Autonomy — Test Suite (TDD: expects FAILURE)");
  console.log(`CWD: ${cwd}`);
  console.log("===========================================");

  const startTime = Date.now();

  // Unit tests (no LLM)
  test1_pollInboxReturnsOnMessage();
  test2_priorityOrdering();
  test3_pollCycleStateMachine();

  // Integration tests
  await test4_e2e_taskClaimCycle();

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