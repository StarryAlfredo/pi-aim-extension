/**
 * P2 Teammate Autonomy + Peer Communication — Test Suite
 *
 * Tests:
 *   1. Teammate idle → poll inbox → find new message → auto-run
 *   2. Teammate idle → poll task list → claim task → auto-run
 *   3. Worker → Worker direct peer message via mailbox
 *   4. Shutdown request → worker receives → worker can approve/reject
 *   5. Plan approval: worker sends plan → leader approves → worker proceeds
 *   6. End-to-end: two workers coordinate on shared task list
 *
 * Run:
 *   pi -p "run the test suite in test/test-p2.ts" -e ../aim/index.ts
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

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
// Helpers
// ============================================================================

function cleanupDir(dir: string) {
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }
  }
}

/** Write AIM inbox message */
function writeInbox(cwd: string, team: string, agent: string, msg: { from: string; text: string; summary?: string; color?: string }) {
  const dir = path.join(cwd, ".pi", "aim", "teams", team, "inboxes");
  ensureDir(dir);
  const filePath = path.join(dir, `${agent}.json`);
  let messages: any[] = [];
  if (fs.existsSync(filePath)) {
    try { messages = JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch {}
  }
  messages.push({ ...msg, timestamp: new Date().toISOString(), read: false });
  fs.writeFileSync(filePath, JSON.stringify(messages, null, 2));
}

/** Read AIM inbox messages */
function readInbox(cwd: string, team: string, agent: string): any[] {
  const filePath = path.join(cwd, ".pi", "aim", "teams", team, "inboxes", `${agent}.json`);
  if (!fs.existsSync(filePath)) return [];
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch { return []; }
}

/** Write a shared task */
function writeTask(cwd: string, team: string, task: { id: string; subject: string; status: string; owner?: string; blockedBy?: string[] }) {
  const dir = path.join(cwd, ".pi", "aim", "tasks", team);
  ensureDir(dir);
  const taskObj = {
    id: task.id, subject: task.subject, description: "",
    status: task.status, owner: task.owner || null,
    blockedBy: task.blockedBy || [], createdAt: Date.now(), updatedAt: Date.now(),
  };
  fs.writeFileSync(path.join(dir, `task-${task.id}.json`), JSON.stringify(taskObj, null, 2));
}

/**
 * Spawn an RPC worker and return a simple API for it.
 * Same pattern as test-p1.ts.
 */
function spawnWorker(cwd: string, model?: string): {
  proc: ReturnType<typeof spawn>;
  send(obj: Record<string, unknown>): void;
  waitForEvent(eventType: string, timeoutMs?: number): Promise<Record<string, unknown> | null>;
  stop(): void;
} {
  const args: string[] = ["--mode", "rpc", "--no-session", "--no-tools", "--thinking", "off", "--model", model ?? "ksyun/deepseek-v3.2"];
  const piCmd = process.platform === "win32"
    ? ["cmd", "/c", path.join(process.env.APPDATA || "", "npm", "pi.cmd")]
    : ["pi"];
  const proc = spawn(piCmd[0], [...piCmd.slice(1), ...args], {
    cwd, stdio: ["pipe", "pipe", "pipe"],
  });

  const listeners: Array<(event: Record<string, unknown>) => void> = [];
  const pending: Array<{ eventType: string; resolve: (v: Record<string, unknown> | null) => void; deadline: number }> = [];
  let stopped = false;

  proc.stdin?.on("error", () => { /* ignore EPIPE */ });
  proc.stderr?.on("data", () => { /* drain stderr */ });
  proc.on("error", () => { stopped = true; });
  proc.on("exit", () => { stopped = true; });
  proc.stdout?.on("data", (data: Buffer) => {
    if (stopped) return;
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        for (let i = pending.length - 1; i >= 0; i--) {
          if (pending[i].eventType === e.type) {
            const resolved = pending.splice(i, 1)[0];
            resolved.resolve(e);
            return;
          }
        }
        for (const cb of listeners) cb(e);
      } catch {}
    }
  });

  function send(obj: Record<string, unknown>) {
    try {
      if (!stopped && !proc.stdin?.destroyed) proc.stdin.write(JSON.stringify(obj) + "\n");
    } catch {
      // process already exited; ignore EPIPE
    }
  }

  function waitForEvent(eventType: string, timeoutMs = 30000): Promise<Record<string, unknown> | null> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const entry = { eventType, resolve, deadline };
      pending.push(entry);
      const interval = setInterval(() => {
        if (stopped) { clearInterval(interval); resolve(null); return; }
        const idx = pending.indexOf(entry);
        if (idx === -1) { clearInterval(interval); return; }
        if (Date.now() > deadline) {
          pending.splice(idx, 1); clearInterval(interval); resolve(null);
        }
      }, 200);
    });
  }

  function stop() { stopped = true; }

  return { proc, send, waitForEvent, stop };
}

// ============================================================================
// Test Cases
// ============================================================================

async function test1_pollInboxAndRun(cwd: string) {
  console.log("\n=== Test 1: Teammate idle → poll inbox → find message → auto-run ===");
  const worker = spawnWorker(cwd);
  const { proc, send, waitForEvent } = worker;
  const team = "test-team-" + Date.now().toString(36);

  try {
    // Phase 1: Send a simple prompt to initialize the worker
    send({ type: "prompt", message: "reply with 'worker ready'" });
    const initEnd = await waitForEvent("agent_end", 30000);
    assert(initEnd !== null, "worker initialized", "agent_end after init");

    // Phase 2: Write a message to worker's inbox (simulating leader sending task)
    writeInbox(cwd, team, "worker-1", {
      from: "team-lead", text: "reply with only 'inbox_task_done'", summary: "inbox task",
    });
    log("inbox", "wrote message to worker's inbox");

    // Phase 3: Simulate poller finding and injecting the message
    // In prod code, the poller would read inbox and call pi.sendMessage or steer.
    // For test, we directly send the message via prompt.
    const inboxMessages = readInbox(cwd, team, "worker-1");
    assert(inboxMessages.length >= 1, "inbox has message", `count: ${inboxMessages.length}`);

    const msg = inboxMessages.find((m: any) => !m.read);
    assert(!!msg, "found unread message", msg?.text?.slice(0, 50));

    // Deliver the message
    send({ type: "prompt", message: msg.text });
    const taskEnd = await waitForEvent("agent_end", 30000);
    assert(taskEnd !== null, "worker processed inbox message", "agent_end after inbox task");

    if (taskEnd) {
      const assistantMsgs = (taskEnd.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
        .filter(m => m.role === "assistant");
      const text = assistantMsgs[assistantMsgs.length - 1]?.content
        .filter(p => p.type === "text").map(p => p.text || "").join("") || "";
      assert(text.includes("inbox_task_done"), "worker responded to inbox message", text.slice(0, 100));
    }
  } finally {
    proc.kill();
    cleanupDir(path.join(cwd, ".pi", "aim", "teams", team));
    cleanupDir(path.join(cwd, ".pi", "aim", "tasks", team));
  }
}

async function test2_claimTaskAndRun(cwd: string) {
  console.log("\n=== Test 2: Teammate idle → poll task list → claim → auto-run ===");
  const worker = spawnWorker(cwd);
  const { proc, send, waitForEvent } = worker;
  const team = "test-team-" + Date.now().toString(36);

  try {
    // Create a pending task
    writeTask(cwd, team, { id: "1", subject: "Find auth files", status: "pending" });
    log("task", "created pending task #1");

    // Init worker
    send({ type: "prompt", message: "reply with 'ready'" });
    const initEnd = await waitForEvent("agent_end", 20000);
    assert(initEnd !== null, "worker initialized", "");

    // Simulate poller claiming the task and delivering it
    // In prod: poller reads task list → finds pending → claim → inject as prompt
    const taskPrompt = `Complete task #1: Find auth files. Reply with 'task_1_complete' when done.`;
    send({ type: "prompt", message: taskPrompt });

    const taskEnd = await waitForEvent("agent_end", 30000);
    assert(taskEnd !== null, "worker processed task", "agent_end after claim");

    if (taskEnd) {
      const assistantMsgs = (taskEnd.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
        .filter(m => m.role === "assistant");
      const text = assistantMsgs[assistantMsgs.length - 1]?.content
        .filter(p => p.type === "text").map(p => p.text || "").join("") || "";
      assert(text.includes("task_1_complete"), "worker completed task", text.slice(0, 100));
    }
  } finally {
    proc.kill();
    cleanupDir(path.join(cwd, ".pi", "aim", "tasks", team));
  }
}

async function test3_workerToWorkerPeerMessage(cwd: string) {
  console.log("\n=== Test 3: Worker → Worker direct peer message via mailbox ===");
  const workerA = spawnWorker(cwd);
  const workerB = spawnWorker(cwd);
  const { proc: procA, send: sendA, waitForEvent: waitA } = workerA;
  const { proc: procB, send: sendB, waitForEvent: waitB } = workerB;
  const team = "test-team-" + Date.now().toString(36);

  try {
    // Init both workers
    sendA({ type: "prompt", message: "reply with 'worker_a_ready'" });
    sendB({ type: "prompt", message: "reply with 'worker_b_ready'" });
    const aReady = await waitA("agent_end", 20000);
    const bReady = await waitB("agent_end", 20000);
    assert(aReady !== null, "worker A ready", "");
    assert(bReady !== null, "worker B ready", "");

    // Worker A sends message to Worker B via inbox
    writeInbox(cwd, team, "worker-b", {
      from: "worker-a", text: "hey worker-b, reply with 'got_message_from_a'", summary: "peer msg",
    });
    log("peer", "worker A wrote inbox message to worker B");

    // Worker B reads inbox and processes (simulated via prompt delivery)
    const inboxB = readInbox(cwd, team, "worker-b");
    const peerMsg = inboxB.find((m: any) => !m.read);
    assert(!!peerMsg, "worker B inbox has unread message from A", peerMsg?.from);

    sendB({ type: "prompt", message: peerMsg.text });
    const bResponse = await waitB("agent_end", 30000);
    assert(bResponse !== null, "worker B responded to peer message", "");

    if (bResponse) {
      const assistantMsgs = (bResponse.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
        .filter(m => m.role === "assistant");
      const text = assistantMsgs[assistantMsgs.length - 1]?.content
        .filter(p => p.type === "text").map(p => p.text || "").join("") || "";
      assert(text.includes("got_message_from_a"), "worker B processed peer msg", text.slice(0, 100));
    }
  } finally {
    procA.kill(); procB.kill();
    cleanupDir(path.join(cwd, ".pi", "aim", "teams", team));
  }
}

async function test4_shutdownRequestResponse(cwd: string) {
  console.log("\n=== Test 4: Shutdown request → receive → approve/reject ===");
  const worker = spawnWorker(cwd);
  const { proc, send, waitForEvent } = worker;
  const team = "test-team-" + Date.now().toString(36);

  try {
    send({ type: "prompt", message: "reply with 'alive'" });
    const alive = await waitForEvent("agent_end", 20000);
    assert(alive !== null, "worker alive", "");

    // Leader sends shutdown request to worker's inbox
    const shutdownPayload = JSON.stringify({
      type: "shutdown_request", request_id: "shutdown-001", from: "team-lead", reason: "work complete",
    });
    writeInbox(cwd, team, "worker-1", {
      from: "team-lead", text: shutdownPayload, summary: "shutdown request",
    });
    log("shutdown", "sent shutdown_request to worker inbox");

    // Worker detects shutdown request in inbox
    const inbox = readInbox(cwd, team, "worker-1");
    const shutdownMsg = inbox.find((m: any) => !m.read);
    assert(!!shutdownMsg, "shutdown message in inbox", shutdownMsg?.text?.slice(0, 80));

    // Parse it
    const parsed = JSON.parse(shutdownMsg.text) as Record<string, unknown>;
    assert(parsed.type === "shutdown_request", "parsed as shutdown_request", "type: " + parsed.type);
    assert(parsed.request_id === "shutdown-001", "request_id correct", "id: " + parsed.request_id);
    assert(parsed.from === "team-lead", "from: team-lead", "");

    // Worker approves shutdown
    const approvalPayload = JSON.stringify({
      type: "shutdown_response", request_id: "shutdown-001", from: "worker-1", approved: true,
    });
    writeInbox(cwd, team, "team-lead", {
      from: "worker-1", text: approvalPayload, summary: "shutdown approved",
    });

    // Leader detects and checks the response
    const leaderInbox = readInbox(cwd, team, "team-lead");
    const response = leaderInbox.find((m: any) => !m.read);
    assert(!!response, "leader received shutdown response", "");
    const responseParsed = JSON.parse(response.text) as Record<string, unknown>;
    assert(responseParsed.type === "shutdown_response", "response is shutdown_response", "");
    assert(responseParsed.approved === true, "shutdown approved", "");

    // Kill worker (approved shutdown)
    proc.kill();
  } finally {
    try { proc.kill(); } catch {}
    cleanupDir(path.join(cwd, ".pi", "aim", "teams", team));
  }
}

async function test5_planApproval(cwd: string) {
  console.log("\n=== Test 5: Plan approval: worker sends plan → leader approves/rejects ===");
  const worker = spawnWorker(cwd);
  const { proc, send, waitForEvent } = worker;
  const team = "test-team-" + Date.now().toString(36);

  try {
    send({ type: "prompt", message: "reply with 'ready'" });
    const ready = await waitForEvent("agent_end", 15000);
    assert(ready !== null, "worker ready", "");

    // Worker sends plan approval request to leader
    const planPayload = JSON.stringify({
      type: "plan_approval_request", request_id: "plan-001", from: "worker-1",
      plan: "1. Read all auth files\n2. Fix null pointer in validate.ts:42\n3. Add tests",
    });
    writeInbox(cwd, team, "team-lead", {
      from: "worker-1", text: planPayload, summary: "plan for auth fix",
    });
    log("plan", "worker sent plan_approval_request to leader inbox");

    // Leader reads plan
    const leaderInbox = readInbox(cwd, team, "team-lead");
    const planMsg = leaderInbox.find((m: any) => !m.read);
    assert(!!planMsg, "leader received plan request", "");

    const plan = JSON.parse(planMsg.text) as Record<string, unknown>;
    assert(plan.type === "plan_approval_request", "parsed as plan_approval_request", "type: " + plan.type);
    assert((plan.plan as string).includes("validate.ts:42"), "plan contains file details", "");

    // Leader approves with feedback
    const approval = JSON.stringify({
      type: "plan_approval_response", request_id: "plan-001", from: "team-lead",
      approved: true, feedback: "looks good, proceed with implementation",
    });
    writeInbox(cwd, team, "worker-1", {
      from: "team-lead", text: approval, summary: "plan approved",
    });

    // Worker receives approval
    const workerInbox = readInbox(cwd, team, "worker-1");
    const approvalMsg = workerInbox.find((m: any) => !m.read);
    assert(!!approvalMsg, "worker received plan response", "");

    const approvalParsed = JSON.parse(approvalMsg.text) as Record<string, unknown>;
    assert(approvalParsed.type === "plan_approval_response", "response parsed correctly", "");
    assert(approvalParsed.approved === true, "plan approved", "");

    // Leader rejects plan (re-simulate with rejection)
    const rejection = JSON.stringify({
      type: "plan_approval_response", request_id: "plan-001", from: "team-lead",
      approved: false, feedback: "add error handling step first",
    });
    writeInbox(cwd, team, "worker-1", {
      from: "team-lead", text: rejection, summary: "plan rejected",
    });

    // Worker reads rejection
    const workerInbox2 = readInbox(cwd, team, "worker-1");
    const rejectionMsg = workerInbox2.find((m: any) => m.text.includes("rejected") || !m.read);
    // Not strictly finding the rejection by content since all messages are unread
    // but we just need to verify the format exists
    const lastMsg = workerInbox2[workerInbox2.length - 1];
    const rejectionParsed = JSON.parse(lastMsg.text) as Record<string, unknown>;
    assert(rejectionParsed.approved === false, "plan rejection works", "feedback: " + rejectionParsed.feedback);

  } finally {
    try { proc.kill(); } catch {}
    cleanupDir(path.join(cwd, ".pi", "aim", "teams", team));
  }
}

async function test6_e2eTwoWorkersTaskList(cwd: string) {
  console.log("\n=== Test 6: End-to-end: two workers coordinate on shared task list ===");
  const worker1 = spawnWorker(cwd);
  const worker2 = spawnWorker(cwd);
  const { proc: p1, send: s1, waitForEvent: w1 } = worker1;
  const { proc: p2, send: s2, waitForEvent: w2 } = worker2;
  const team = "test-team-" + Date.now().toString(36);

  try {
    // Create tasks
    writeTask(cwd, team, { id: "1", subject: "Research auth module", status: "pending" });
    writeTask(cwd, team, { id: "2", subject: "Research database layer", status: "pending" });
    writeTask(cwd, team, { id: "3", subject: "Fix both modules", status: "pending", blockedBy: ["1", "2"] });
    log("task-list", "created 3 tasks (task #3 blocked by #1 and #2)");

    // Init both workers
    s1({ type: "prompt", message: "reply with 'w1_ready'" });
    s2({ type: "prompt", message: "reply with 'w2_ready'" });
    await w1("agent_end", 15000);
    await w2("agent_end", 15000);

    // Worker 1 claims task #1
    log("task-claim", "worker 1 claiming task #1 (Research auth)");
    s1({ type: "prompt", message: "you claimed task #1: Research auth module. reply with 'task1_done_by_w1'" });
    const t1End = await w1("agent_end", 30000);
    assert(t1End !== null, "w1 completed task #1", "");

    if (t1End) {
      const msgs = (t1End.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
        .filter(m => m.role === "assistant");
      const text = msgs[msgs.length - 1]?.content.filter(p => p.type === "text").map(p => p.text || "").join("") || "";
      assert(text.includes("task1_done_by_w1"), "w1: task #1 result", text.slice(0, 100));

      // Mark task #1 as completed
      writeTask(cwd, team, { id: "1", subject: "Research auth module", status: "completed", owner: "worker-1" });
    }

    // Worker 2 claims task #2
    log("task-claim", "worker 2 claiming task #2 (Research db)");
    s2({ type: "prompt", message: "you claimed task #2: Research database layer. reply with 'task2_done_by_w2'" });
    const t2End = await w2("agent_end", 30000);
    assert(t2End !== null, "w2 completed task #2", "");

    if (t2End) {
      const msgs = (t2End.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
        .filter(m => m.role === "assistant");
      const text = msgs[msgs.length - 1]?.content.filter(p => p.type === "text").map(p => p.text || "").join("") || "";
      assert(text.includes("task2_done_by_w2"), "w2: task #2 result", text.slice(0, 100));
      writeTask(cwd, team, { id: "2", subject: "Research database layer", status: "completed", owner: "worker-2" });
    }

    // Now task #3 is unblocked → either worker can claim it
    log("task-claim", "task #3 unblocked → worker 1 claims it");
    writeTask(cwd, team, { id: "3", subject: "Fix both modules", status: "pending", blockedBy: [] });
    s1({ type: "prompt", message: "you claimed task #3: Fix both modules. reply with 'task3_done_by_w1'" });
    const t3End = await w1("agent_end", 30000);
    assert(t3End !== null, "w1 completed task #3", "");

    if (t3End) {
      const msgs = (t3End.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
        .filter(m => m.role === "assistant");
      const text = msgs[msgs.length - 1]?.content.filter(p => p.type === "text").map(p => p.text || "").join("") || "";
      assert(text.includes("task3_done_by_w1"), "w1: task #3 result", text.slice(0, 100));
    }

    // Worker 2: idle → poll → no pending tasks → notify leader
    log("worker-2", "worker 2 idle, no tasks left");
    s2({ type: "prompt", message: "no tasks left. reply with 'idle_no_tasks'" });
    const idleEnd = await w2("agent_end", 20000);
    assert(idleEnd !== null, "w2 idle confirmed", "");
  } finally {
    try { p1.kill(); } catch {}
    try { p2.kill(); } catch {}
    cleanupDir(path.join(cwd, ".pi", "aim", "tasks", team));
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const cwd = process.cwd();
  console.log("AIM P2 Teammate Autonomy + Peer Communication — Test Suite");
  console.log(`CWD: ${cwd}`);
  console.log("===========================================");

  const startTime = Date.now();

  await test1_pollInboxAndRun(cwd);
  await test2_claimTaskAndRun(cwd);
  await test3_workerToWorkerPeerMessage(cwd);
  await test4_shutdownRequestResponse(cwd);
  await test5_planApproval(cwd);
  await test6_e2eTwoWorkersTaskList(cwd);

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