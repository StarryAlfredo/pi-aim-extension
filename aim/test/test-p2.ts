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

// AIM module imports are loaded lazily inside test functions to avoid module
// resolution issues before the test runner sets up the environment.
// Each test function imports the real AIM modules it needs:
//   mailbox.ts:  writeToMailbox, readMailbox, markMessageAsRead, createShutdownRequest, createShutdownApproval, createIdleNotification
//   shared-tasks.ts:  createTask, claimTask, listTasks, findAvailableTask

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
    ? ["cmd", "/c", "pi.cmd"]
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
  const { writeToMailbox, readMailbox, markMessageAsRead } = await import("../mailbox.js");
  const worker = spawnWorker(cwd);
  const { proc, send, waitForEvent } = worker;
  const team = "test-team-" + Date.now().toString(36);
  const agentName = "worker-1";

  try {
    // Phase 1: Send a simple prompt to initialize the worker
    send({ type: "prompt", message: "reply with 'worker ready'" });
    const initEnd = await waitForEvent("agent_end", 30000);
    assert(initEnd !== null, "worker initialized", "agent_end after init");

    // Phase 2: Use real AIM writeToMailbox to send message
    await writeToMailbox(cwd, agentName, {
      from: "team-lead",
      text: "reply with only 'inbox_task_done'",
      timestamp: new Date().toISOString(),
      summary: "inbox task",
    }, team);
    log("inbox", "wrote message via real writeToMailbox");

    // Phase 3: Use real AIM readMailbox (same as poller would)
    const inboxMessages = await readMailbox(cwd, agentName, team);
    assert(inboxMessages.length >= 1, "inbox has message via readMailbox", `count: ${inboxMessages.length}`);

    const unread = inboxMessages.filter((m: any) => !m.read);
    assert(unread.length >= 1, "found unread message", unread[0]?.text?.slice(0, 50));
    const msg = unread[0];

    // Phase 4: Deliver the message to worker
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

    // Phase 5: Mark as read
    await markMessageAsRead(cwd, agentName, team, 0);
    const after = await readMailbox(cwd, agentName, team);
    assert(after[0]?.read === true, "message marked read via real module", "");
  } finally {
    proc.kill();
    cleanupDir(path.join(cwd, ".pi", "aim", "teams", team));
    cleanupDir(path.join(cwd, ".pi", "aim", "tasks", team));
  }
}

async function test2_claimTaskAndRun(cwd: string) {
  console.log("\n=== Test 2: Teammate idle → poll task list → claim → auto-run ===");
  const { createTask: aimCreateTask, claimTask: aimClaimTask, listTasks: aimListTasks } = await import("../shared-tasks.js");
  const worker = spawnWorker(cwd);
  const { proc, send, waitForEvent } = worker;
  const team = "test-team-" + Date.now().toString(36);

  try {
    // Create a pending task via real AIM createTask
    const task = await aimCreateTask(cwd, team, "Find auth files", "Locate all authentication-related source files");
    assert(!!task, "task created via real createTask", `id: ${task.id}, subject: ${task.subject}`);
    log("task", `created pending task #${task.id} via real createTask`);

    // Verify it's in the list
    const before = aimListTasks(cwd, team);
    assert(before.length >= 1, "task visible in listTasks", `count: ${before.length}`);
    assert(before[0].status === "pending", "task is pending", "");

    // Init worker
    send({ type: "prompt", message: "reply with 'ready'" });
    const initEnd = await waitForEvent("agent_end", 20000);
    assert(initEnd !== null, "worker initialized", "");

    // Claim the task via real AIM claimTask
    const claimed = await aimClaimTask(cwd, team, task.id, "worker-1");
    if ('rejected' in claimed) throw new Error('claim rejected: ' + claimed.reason);
    assert("task" in claimed, "task claimed via real claimTask", `claimed id: ${claimed.task?.id}`);
    assert(claimed.task?.status === "in_progress", "task status is in_progress", "");
    assert(claimed.task?.owner === "worker-1", "task owner set", "");
    log("task", "task claimed via real claimTask");

    // Deliver to worker
    const taskPrompt = `Complete task #${claimed.task?.id}: ${claimed.task?.subject}. Reply with 'task_1_complete' when done.`;
    send({ type: "prompt", message: taskPrompt });

    const taskEnd = await waitForEvent("agent_end", 60000);
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
  const { writeToMailbox, readMailbox } = await import("../mailbox.js");
  const workerA = spawnWorker(cwd);
  const workerB = spawnWorker(cwd);
  const { proc: procA, send: sendA, waitForEvent: waitA } = workerA;
  const { proc: procB, send: sendB, waitForEvent: waitB } = workerB;
  const team = "test-team-" + Date.now().toString(36);

  try {
    // Init both workers (run in parallel for speed)
    sendA({ type: "prompt", message: "reply with 'worker_a_ready'" });
    sendB({ type: "prompt", message: "reply with 'worker_b_ready'" });
    const [aReady, bReady] = await Promise.all([
      waitA("agent_end", 60000),
      waitB("agent_end", 60000),
    ]);
    assert(aReady !== null, "worker A ready", "");
    assert(bReady !== null, "worker B ready", "");

    // Worker A sends message to Worker B via real writeToMailbox
    await writeToMailbox(cwd, "worker-b", {
      from: "worker-a",
      text: "hey worker-b, reply with 'got_message_from_a'",
      timestamp: new Date().toISOString(),
      summary: "peer msg",
    }, team);
    log("peer", "worker A wrote inbox message via real writeToMailbox");

    // Worker B reads inbox via real readMailbox
    const inboxB = await readMailbox(cwd, "worker-b", team);
    const unread = inboxB.filter((m: any) => !m.read);
    assert(unread.length >= 1, "worker B inbox has unread message from A", unread[0]?.from);
    const peerMsg = unread[0];

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
  const {
    writeToMailbox, readMailbox,
    createShutdownRequest, createShutdownApproval,
    isShutdownRequest,
  } = await import("../mailbox.js");
  const worker = spawnWorker(cwd);
  const { proc, send, waitForEvent } = worker;
  const team = "test-team-" + Date.now().toString(36);

  try {
    send({ type: "prompt", message: "reply with 'alive'" });
    const alive = await waitForEvent("agent_end", 20000);
    assert(alive !== null, "worker alive", "");

    // Leader sends shutdown request via real createShutdownRequest + writeToMailbox
    const shutdownPayload = createShutdownRequest("shutdown-001", "team-lead", "work complete");
    await writeToMailbox(cwd, "worker-1", {
      from: "team-lead",
      text: shutdownPayload,
      timestamp: new Date().toISOString(),
      summary: "shutdown request",
    }, team);
    log("shutdown", "sent shutdown_request via real createShutdownRequest + writeToMailbox");

    // Worker detects shutdown via real isShutdownRequest
    const inbox = await readMailbox(cwd, "worker-1", team);
    const unread = inbox.filter((m: any) => !m.read);
    assert(unread.length >= 1, "shutdown message in inbox", unread[0]?.text?.slice(0, 80));

    const parsed = isShutdownRequest(unread[0].text);
    assert(parsed !== null, "isShutdownRequest parsed correctly", "");
    assert(parsed?.request_id === "shutdown-001", "request_id correct", "");
    assert(parsed?.from === "team-lead", "from: team-lead", "");

    // Worker approves via real createShutdownApproval
    const approvalPayload = createShutdownApproval("shutdown-001", "worker-1");
    await writeToMailbox(cwd, "team-lead", {
      from: "worker-1",
      text: approvalPayload,
      timestamp: new Date().toISOString(),
      summary: "shutdown approved",
    }, team);

    // Leader reads response via real readMailbox
    const leaderInbox = await readMailbox(cwd, "team-lead", team);
    const leaderUnread = leaderInbox.filter((m: any) => !m.read);
    assert(leaderUnread.length >= 1, "leader received shutdown response", "");
    const responseParsed = JSON.parse(leaderUnread[0].text) as Record<string, unknown>;
    assert(responseParsed.type === "shutdown_response", "response is shutdown_response", "");
    assert(responseParsed.approved === true, "shutdown approved", "");

    proc.kill();
  } finally {
    try { proc.kill(); } catch {}
    cleanupDir(path.join(cwd, ".pi", "aim", "teams", team));
  }
}

async function test5_planApproval(cwd: string) {
  console.log("\n=== Test 5: Plan approval: worker sends plan → leader approves/rejects ===");
  const {
    writeToMailbox, readMailbox,
    createPlanApprovalRequest, createPlanApprovalResponse,
  } = await import("../mailbox.js");
  const worker = spawnWorker(cwd);
  const { proc, send, waitForEvent } = worker;
  const team = "test-team-" + Date.now().toString(36);

  try {
    send({ type: "prompt", message: "reply with 'ready'" });
    const ready = await waitForEvent("agent_end", 15000);
    assert(ready !== null, "worker ready", "");

    // Worker sends plan via real createPlanApprovalRequest + writeToMailbox
    const planPayload = createPlanApprovalRequest(
      "plan-001", "worker-1",
      "1. Read all auth files\n2. Fix null pointer in validate.ts:42\n3. Add tests",
    );
    await writeToMailbox(cwd, "team-lead", {
      from: "worker-1",
      text: planPayload,
      timestamp: new Date().toISOString(),
      summary: "plan for auth fix",
    }, team);
    log("plan", "worker sent plan_approval_request via real createPlanApprovalRequest");

    // Leader reads plan via real readMailbox
    const leaderInbox = await readMailbox(cwd, "team-lead", team);
    const planMsg = leaderInbox.find((m: any) => !m.read);
    assert(!!planMsg, "leader received plan request", "");

    const plan = JSON.parse(planMsg!.text) as Record<string, unknown>;
    assert(plan.type === "plan_approval_request", "parsed as plan_approval_request", "type: " + plan.type);
    assert((plan.plan as string).includes("validate.ts:42"), "plan contains file details", "");

    // Leader approves via real createPlanApprovalResponse
    const approval = createPlanApprovalResponse("plan-001", "team-lead", true, "looks good, proceed");
    await writeToMailbox(cwd, "worker-1", {
      from: "team-lead",
      text: approval,
      timestamp: new Date().toISOString(),
      summary: "plan approved",
    }, team);

    // Worker receives approval
    const workerInbox = await readMailbox(cwd, "worker-1", team);
    const approvalMsg = workerInbox.find((m: any) => !m.read);
    assert(!!approvalMsg, "worker received plan response", "");
    const approvalParsed = JSON.parse(approvalMsg!.text) as Record<string, unknown>;
    assert(approvalParsed.type === "plan_approval_response", "approval parsed correctly", "");
    assert(approvalParsed.approved === true, "plan approved", "");

    // Leader rejects via real createPlanApprovalResponse
    const rejection = createPlanApprovalResponse("plan-001", "team-lead", false, "add error handling first");
    await writeToMailbox(cwd, "worker-1", {
      from: "team-lead",
      text: rejection,
      timestamp: new Date().toISOString(),
      summary: "plan rejected",
    }, team);

    // Worker reads rejection
    const workerInbox2 = await readMailbox(cwd, "worker-1", team);
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
  const { createTask: aimCreateTask, claimTask: aimClaimTask, listTasks } = await import("../shared-tasks.js");
  const worker1 = spawnWorker(cwd);
  const worker2 = spawnWorker(cwd);
  const { proc: p1, send: s1, waitForEvent: w1 } = worker1;
  const { proc: p2, send: s2, waitForEvent: w2 } = worker2;
  const team = "test-team-" + Date.now().toString(36);

  try {
    // Create tasks via real AIM createTask
    const t1 = await aimCreateTask(cwd, team, "Research auth module", "Find all auth-related code");
    const t2 = await aimCreateTask(cwd, team, "Research database layer", "Find all DB-related code");
    const t3 = await aimCreateTask(cwd, team, "Fix both modules", "Apply fixes based on research");
    assert(t3 !== null, "task created with blockedBy via real createTask", "");
    log("task-list", `created 3 tasks via real createTask (task #${t3.id} blocked by #${t1.id} and #${t2.id})`);

    // Init both workers in parallel
    s1({ type: "prompt", message: "reply with 'w1_ready'" });
    s2({ type: "prompt", message: "reply with 'w2_ready'" });
    const [r1, r2] = await Promise.all([
      w1("agent_end", 60000),
      w2("agent_end", 60000),
    ]);
    assert(r1 !== null, "w1 init", "");
    assert(r2 !== null, "w2 init", "");

    // Worker 1 claims task #1
    log("task-claim", "worker 1 claiming task via real claimTask");
    const claimed1 = await aimClaimTask(cwd, team, t1.id, "worker-1");
    if ('rejected' in claimed1) throw new Error('claim rejected: ' + claimed1.reason);
    assert("task" in claimed1, "w1 claimed task #1", `status: ${claimed1.task?.status}`);

    s1({ type: "prompt", message: `you claimed task #${claimed1.task?.id}: ${claimed1.task?.subject}. reply with 'task1_done_by_w1'` });
    const t1End = await w1("agent_end", 30000);
    assert(t1End !== null, "w1 completed task #1", "");

    if (t1End) {
      const msgs = (t1End.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
        .filter(m => m.role === "assistant");
      const text = msgs[msgs.length - 1]?.content.filter(p => p.type === "text").map(p => p.text || "").join("") || "";
      assert(text.includes("task1_done_by_w1"), "w1: task #1 result", text.slice(0, 100));
    }

    // Worker 2 claims task #2
    log("task-claim", "worker 2 claiming task via real claimTask");
    const claimed2 = await aimClaimTask(cwd, team, t2.id, "worker-2");
    if ('rejected' in claimed2) throw new Error('claim rejected: ' + claimed2.reason);
    assert("task" in claimed2, "w2 claimed task #2", `status: ${claimed2.task?.status}`);

    s2({ type: "prompt", message: `you claimed task #${claimed2.task?.id}: ${claimed2.task?.subject}. reply with 'task2_done_by_w2'` });
    const t2End = await w2("agent_end", 30000);
    assert(t2End !== null, "w2 completed task #2", "");

    if (t2End) {
      const msgs = (t2End.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
        .filter(m => m.role === "assistant");
      const text = msgs[msgs.length - 1]?.content.filter(p => p.type === "text").map(p => p.text || "").join("") || "";
      assert(text.includes("task2_done_by_w2"), "w2: task #2 result", text.slice(0, 100));
    }

    // Use real updateTask to mark tasks complete (so blockedBy resolves)
    const { updateTask } = await import("../shared-tasks.js");
    await updateTask(cwd, team, t1.id, { status: "completed" });
    await updateTask(cwd, team, t2.id, { status: "completed" });
    const allTasks = listTasks(cwd, team);
    assert(allTasks.filter(t => t.status === "completed").length === 2, "tasks 1 and 2 completed", "");

    // Now task #3 is unblocked → claim it
    log("task-claim", "task #3 unblocked → worker 1 claims via real claimTask");
    const claimed3 = await aimClaimTask(cwd, team, t3.id, "worker-1");
    if ('rejected' in claimed3) throw new Error('claim rejected: ' + claimed3.reason);
    assert("task" in claimed3, "w1 claimed task #3 (unblocked after deps completed)", `status: ${claimed3.task?.status}`);

    s1({ type: "prompt", message: `you claimed task #${claimed3.task?.id}: ${claimed3.task?.subject}. reply with 'task3_done_by_w1'` });
    const t3End = await w1("agent_end", 30000);
    assert(t3End !== null, "w1 completed task #3", "");

    if (t3End) {
      const msgs = (t3End.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)
        .filter(m => m.role === "assistant");
      const text = msgs[msgs.length - 1]?.content.filter(p => p.type === "text").map(p => p.text || "").join("") || "";
      assert(text.includes("task3_done_by_w1"), "w1: task #3 result", text.slice(0, 100));
    }

    // Worker 2: idle → poll → no pending tasks
    log("worker-2", "worker 2 idle, no tasks left");
    s2({ type: "prompt", message: "no tasks left. reply with 'idle_no_tasks'" });
    const idleEnd = await w2("agent_end", 20000);
    assert(idleEnd !== null, "w2 idle confirmed", "");

    // Verify final state
    const final = listTasks(cwd, team);
    assert(final.length === 3, "all 3 tasks exist", "");
    const completed = final.filter(t => t.status === "completed" || t.status === "in_progress");
    assert(completed.length === 3, "all tasks in final state", JSON.stringify(final.map(t => ({ id: t.id, status: t.status }))));
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