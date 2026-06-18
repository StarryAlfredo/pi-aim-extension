/**
 * AIM — Task System Test Suite (P0-P8)
 *
 * Comprehensive tests for the P0-P8 task system features.
 * All tests are pure logic — no LLM subprocess needed.
 *
 * Run: npx tsx test/test-task-system.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Test Helpers
// ============================================================================

let testCount = 0;
let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function assert(condition: boolean, test: string, detail: string): void {
  testCount++;
  if (condition) {
    passCount++;
  } else {
    failCount++;
    failures.push(`${test}: ${detail}`);
  }
}

function log(phase: string, msg: string): void {
  console.log(`  [${phase}] ${msg}`);
}

/** Create an isolated temp directory for a test */
function createTestDir(): string {
  const dir = path.join(os.tmpdir(), `aim-test-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove the temp directory and all contents */
function cleanupTestDir(dir: string): void {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/** Assert that an async function throws */
async function assertThrows(fn: () => Promise<unknown>, test: string, detail: string): Promise<void> {
  testCount++;
  try {
    await fn();
    failCount++;
    failures.push(`${test}: ${detail} (no error thrown)`);
  } catch {
    passCount++;
  }
}

// ============================================================================
// P0 — Foundation Tests
// ============================================================================

async function testP0_types_and_state_machine(): Promise<void> {
  const { isTerminalStatus, canTransition, VALID_TRANSITIONS } = await import("../types.js");
  const test = "P0/state_machine";

  // Terminal statuses
  assert(isTerminalStatus("completed") === true, test, "completed is terminal");
  assert(isTerminalStatus("failed") === true, test, "failed is terminal");
  assert(isTerminalStatus("killed") === true, test, "killed is terminal");

  // Non-terminal statuses
  assert(isTerminalStatus("pending") === false, test, "pending is not terminal");
  assert(isTerminalStatus("in_progress") === false, test, "in_progress is not terminal");

  // Valid transitions
  assert(canTransition("pending", "in_progress") === true, test, "pending→in_progress ok");
  assert(canTransition("pending", "failed") === true, test, "pending→failed ok");
  assert(canTransition("pending", "killed") === true, test, "pending→killed ok");
  assert(canTransition("in_progress", "completed") === true, test, "in_progress→completed ok");
  assert(canTransition("in_progress", "failed") === true, test, "in_progress→failed ok");
  assert(canTransition("in_progress", "killed") === true, test, "in_progress→killed ok");

  // Invalid transitions
  assert(canTransition("completed", "pending") === false, test, "completed→pending blocked");
  assert(canTransition("failed", "in_progress") === false, test, "failed→in_progress blocked");
  assert(canTransition("killed", "pending") === false, test, "killed→pending blocked");
  assert(canTransition("pending", "completed") === false, test, "pending→completed blocked (must go through in_progress)");

  // VALID_TRANSITIONS structure
  assert(VALID_TRANSITIONS["completed"].length === 0, test, "completed has no outgoing transitions");
  assert(VALID_TRANSITIONS["failed"].length === 0, test, "failed has no outgoing transitions");
  assert(VALID_TRANSITIONS["killed"].length === 0, test, "killed has no outgoing transitions");
}

async function testP0_create_task(): Promise<void> {
  const { createTask, listTasks } = await import("../shared-tasks.js");
  const cwd = createTestDir();
  const team = "test-team";

  try {
    // Basic creation
    const t1 = await createTask(cwd, team, "Test task");
    assert(t1.id === "1", "P0/create", "first task id is 1");
    assert(t1.status === "pending", "P0/create", "initial status is pending");
    assert(t1.type === "local_agent", "P0/create", "default type is local_agent");
    assert(t1.subject === "Test task", "P0/create", "subject preserved");
    assert(t1.owner === undefined, "P0/create", "no owner initially");
    assert(t1.blocks.length === 0, "P0/create", "no blocks initially");
    assert(t1.blockedBy.length === 0, "P0/create", "no blockedBy initially");

    // Second task gets next ID
    const t2 = await createTask(cwd, team, "Task 2");
    assert(t2.id === "2", "P0/create", "second task id is 2");

    // With type option
    const t3 = await createTask(cwd, team, "Bash task", "", { type: "local_bash" });
    assert(t3.type === "local_bash", "P0/create", "type override works");

    // With metadata
    const t4 = await createTask(cwd, team, "Meta task", "", { metadata: { key: "val" } });
    assert(t4.metadata?.key === "val", "P0/create", "metadata preserved");

    // With activeForm
    const t5 = await createTask(cwd, team, "Active task", "", { activeForm: "Running tests" });
    assert(t5.activeForm === "Running tests", "P0/create", "activeForm preserved");

    // List returns all 5
    const all = listTasks(cwd, team);
    assert(all.length === 5, "P0/create", "listTasks returns all tasks");
  } finally {
    cleanupTestDir(cwd);
  }
}

async function testP0_highwatermark(): Promise<void> {
  const { createTask, deleteTask, listTasks } = await import("../shared-tasks.js");
  const cwd = createTestDir();
  const team = "hwm-team";

  try {
    const t1 = await createTask(cwd, team, "Task 1");
    const t2 = await createTask(cwd, team, "Task 2");
    const t3 = await createTask(cwd, team, "Task 3");
    assert(t1.id === "1" && t2.id === "2" && t3.id === "3", "P0/hwm", "IDs sequential");

    // Delete task 3
    // Need to force-delete since it's pending (non-terminal)
    await deleteTask(cwd, team, "3", { force: true });

    // Next task should be 4, NOT 3 (high-water mark prevents reuse)
    const t4 = await createTask(cwd, team, "After delete");
    assert(t4.id === "4", "P0/hwm", "high-water mark prevents ID reuse after deletion");

    // Delete task 4 and create again
    await deleteTask(cwd, team, "4", { force: true });
    const t5 = await createTask(cwd, team, "After second delete");
    assert(t5.id === "5", "P0/hwm", "high-water mark keeps incrementing");
  } finally {
    cleanupTestDir(cwd);
  }
}

async function testP0_bidirectional_deps(): Promise<void> {
  const { createTask, blockTask, unblockTask, listTasks } = await import("../shared-tasks.js");
  const cwd = createTestDir();
  const team = "deps-team";

  try {
    const tA = await createTask(cwd, team, "Task A");
    const tB = await createTask(cwd, team, "Task B");

    // blockTask(A, B): A blocks B → A.blocks contains B, B.blockedBy contains A
    await blockTask(cwd, team, tA.id, tB.id);

    const after = listTasks(cwd, team);
    const aAfter = after.find(t => t.id === tA.id)!;
    const bAfter = after.find(t => t.id === tB.id)!;
    assert(aAfter.blocks.includes(tB.id), "P0/bidir", "A.blocks contains B");
    assert(bAfter.blockedBy.includes(tA.id), "P0/bidir", "B.blockedBy contains A");

    // unblockTask: reverse the relationship
    await unblockTask(cwd, team, tA.id, tB.id);

    const afterUnblock = listTasks(cwd, team);
    const aUnblock = afterUnblock.find(t => t.id === tA.id)!;
    const bUnblock = afterUnblock.find(t => t.id === tB.id)!;
    assert(!aUnblock.blocks.includes(tB.id), "P0/bidir", "A.blocks no longer contains B after unblock");
    assert(!bUnblock.blockedBy.includes(tA.id), "P0/bidir", "B.blockedBy no longer contains A after unblock");
  } finally {
    cleanupTestDir(cwd);
  }
}

async function testP0_blockTask_validation(): Promise<void> {
  const { createTask, blockTask, updateTask, claimTask } = await import("../shared-tasks.js");
  const cwd = createTestDir();
  const team = "blockval-team";

  try {
    const t1 = await createTask(cwd, team, "Task 1");
    const t2 = await createTask(cwd, team, "Task 2");

    // Self-dependency → throws
    await assertThrows(() => blockTask(cwd, team, t1.id, t1.id), "P0/blockval", "self-block throws");

    // Non-existent task → throws
    await assertThrows(() => blockTask(cwd, team, "999", t2.id), "P0/blockval", "non-existent blocker throws");
    await assertThrows(() => blockTask(cwd, team, t1.id, "999"), "P0/blockval", "non-existent blocked throws");

    // Circular dependency: A→B then B→A → throws
    await blockTask(cwd, team, t1.id, t2.id);
    await assertThrows(() => blockTask(cwd, team, t2.id, t1.id), "P0/blockval", "circular dep throws");

    // Blocked task in in_progress → throws
    const t3 = await createTask(cwd, team, "Task 3");
    const t4 = await createTask(cwd, team, "Task 4");
    await claimTask(cwd, team, t4.id, "agent-1");
    await updateTask(cwd, team, t4.id, { status: "in_progress" });
    await assertThrows(() => blockTask(cwd, team, t3.id, t4.id), "P0/blockval", "block non-pending task throws");

    // Completed blocker → no-op (returns normally)
    const t5 = await createTask(cwd, team, "Task 5");
    const t6 = await createTask(cwd, team, "Task 6");
    await claimTask(cwd, team, t5.id, "agent-2");
    await updateTask(cwd, team, t5.id, { status: "completed" });
    // Should NOT throw — completed blocker means dependency already satisfied
    await blockTask(cwd, team, t5.id, t6.id);
  } finally {
    cleanupTestDir(cwd);
  }
}

async function testP0_delete_task_cleans_deps(): Promise<void> {
  const { createTask, blockTask, deleteTask, listTasks } = await import("../shared-tasks.js");
  const cwd = createTestDir();
  const team = "deldeps-team";

  try {
    const t1 = await createTask(cwd, team, "Task 1");
    const t2 = await createTask(cwd, team, "Task 2");

    // t1 blocks t2
    await blockTask(cwd, team, t1.id, t2.id);

    // Delete t1 (force because it's non-terminal)
    await deleteTask(cwd, team, t1.id, { force: true });

    // t2's blockedBy should no longer contain t1
    const remaining = listTasks(cwd, team);
    const t2After = remaining.find(t => t.id === t2.id)!;
    assert(!t2After.blockedBy.includes(t1.id), "P0/deldeps", "deleted task removed from blockedBy");
  } finally {
    cleanupTestDir(cwd);
  }
}

async function testP0_update_task_state_machine(): Promise<void> {
  const { createTask, updateTask, claimTask } = await import("../shared-tasks.js");
  const cwd = createTestDir();
  const team = "statemachine-team";

  try {
    // Valid: pending → in_progress
    const t1 = await createTask(cwd, team, "Task 1");
    await claimTask(cwd, team, t1.id, "agent-1");
    const claimed = await updateTask(cwd, team, t1.id, { status: "in_progress" });
    assert(claimed?.status === "in_progress", "P0/statemachine", "pending→in_progress ok");

    // Valid: in_progress → completed
    const completed = await updateTask(cwd, team, t1.id, { status: "completed" });
    assert(completed?.status === "completed", "P0/statemachine", "in_progress→completed ok");

    // Invalid: completed → pending (terminal state protection)
    await assertThrows(
      () => updateTask(cwd, team, t1.id, { status: "pending" }),
      "P0/statemachine", "completed→pending throws (terminal)",
    );

    // Invalid: pending → completed (must go through in_progress)
    const t2 = await createTask(cwd, team, "Task 2");
    await assertThrows(
      () => updateTask(cwd, team, t2.id, { status: "completed" }),
      "P0/statemachine", "pending→completed throws (must go through in_progress)",
    );
  } finally {
    cleanupTestDir(cwd);
  }
}

async function testP0_terminal_state_protection(): Promise<void> {
  const { createTask, updateTask, claimTask } = await import("../shared-tasks.js");
  const cwd = createTestDir();
  const team = "terminal-team";

  try {
    const t1 = await createTask(cwd, team, "Terminal test");
    await claimTask(cwd, team, t1.id, "agent-1");
    await updateTask(cwd, team, t1.id, { status: "completed" });

    // Business field update on terminal → throws
    await assertThrows(
      () => updateTask(cwd, team, t1.id, { owner: "new-owner" }),
      "P0/terminal", "owner update on terminal task throws",
    );
    await assertThrows(
      () => updateTask(cwd, team, t1.id, { description: "new desc" }),
      "P0/terminal", "description update on terminal task throws",
    );

    // Metadata-only update on terminal → allowed
    const metaUpdated = await updateTask(cwd, team, t1.id, { metadata: { reviewed: true } });
    assert(metaUpdated?.metadata?.reviewed === true, "P0/terminal", "metadata update on terminal task allowed");
  } finally {
    cleanupTestDir(cwd);
  }
}

async function testP0_claimTask(): Promise<void> {
  const { createTask, claimTask, updateTask } = await import("../shared-tasks.js");
  const cwd = createTestDir();
  const team = "claim-team";

  try {
    const t1 = await createTask(cwd, team, "Claim test");

    // Successful claim
    const result = await claimTask(cwd, team, t1.id, "agent-1");
    assert(!("rejected" in result), "P0/claim", "first claim succeeds");
    if (!("rejected" in result)) {
      assert(result.task.owner === "agent-1", "P0/claim", "owner set");
      assert(result.task.status === "in_progress", "P0/claim", "status is in_progress");
    }

    // Second claim on same task → rejected
    const result2 = await claimTask(cwd, team, t1.id, "agent-2");
    assert("rejected" in result2, "P0/claim", "second claim rejected");
    if ("rejected" in result2) {
      assert(result2.reason.includes("status_is_in_progress"), "P0/claim", "reason is status check");
    }

    // Agent busy: create another task, same agent can't claim if busy
    const t2 = await createTask(cwd, team, "Second task");
    const busyResult = await claimTask(cwd, team, t2.id, "agent-1");
    assert("rejected" in busyResult, "P0/claim", "busy agent rejected");
    if ("rejected" in busyResult) {
      assert(busyResult.reason === "agent_busy", "P0/claim", "reason is agent_busy");
    }

    // Different agent can claim
    const result3 = await claimTask(cwd, team, t2.id, "agent-2");
    assert(!("rejected" in result3), "P0/claim", "different agent can claim");
  } finally {
    cleanupTestDir(cwd);
  }
}

async function testP0_findAvailableTask(): Promise<void> {
  const { createTask, blockTask, findAvailableTask, claimTask, updateTask } = await import("../shared-tasks.js");
  const cwd = createTestDir();
  const team = "findavail-team";

  try {
    const t1 = await createTask(cwd, team, "Task 1");
    const t2 = await createTask(cwd, team, "Task 2");
    const t3 = await createTask(cwd, team, "Task 3");

    // Block t2 by t1
    await blockTask(cwd, team, t1.id, t2.id);

    // findAvailableTask should return t1 or t3 (unblocked)
    const avail = findAvailableTask(cwd, team);
    assert(avail !== null, "P0/findavail", "found available task");
    assert(avail!.id !== t2.id, "P0/findavail", "blocked task not returned");

    // Complete t1 → t2 becomes unblocked
    await claimTask(cwd, team, t1.id, "agent-1");
    await updateTask(cwd, team, t1.id, { status: "completed" });

    // Now t2 should be available
    const avail2 = findAvailableTask(cwd, team);
    // t2 or t3 should be found (t2 is now unblocked, t3 was always unblocked)
    assert(avail2 !== null, "P0/findavail", "task available after unblock");
  } finally {
    cleanupTestDir(cwd);
  }
}

// ============================================================================
// P1 — Hook Tests
// ============================================================================

async function testP1_created_hook_veto(): Promise<void> {
  const { createTask } = await import("../shared-tasks.js");
  const { registerTaskCreatedHook, clearAllHooks } = await import("../task-hooks.js");
  const cwd = createTestDir();
  const team = "hook-veto-team";

  try {
    // Register veto hook
    registerTaskCreatedHook(async (task, _ctx) => {
      if (task.subject.includes("VETO")) {
        return { allowed: false, reason: "test veto" };
      }
      return { allowed: true };
    });

    // Vetoed creation → throws
    await assertThrows(
      () => createTask(cwd, team, "VETO Task"),
      "P1/hook_veto", "vetoed createTask throws",
    );

    // Non-vetoed creation → succeeds
    const t = await createTask(cwd, team, "Normal Task");
    assert(t.subject === "Normal Task", "P1/hook_veto", "non-vetoed task created");
  } finally {
    clearAllHooks();
    cleanupTestDir(cwd);
  }
}

async function testP1_created_hook_approve(): Promise<void> {
  const { createTask } = await import("../shared-tasks.js");
  const { registerTaskCreatedHook, clearAllHooks } = await import("../task-hooks.js");
  const cwd = createTestDir();
  const team = "hook-approve-team";

  try {
    let hookCalled = false;
    registerTaskCreatedHook(async (_task, _ctx) => {
      hookCalled = true;
      return { allowed: true };
    });

    const t = await createTask(cwd, team, "Approve test");
    assert(hookCalled, "P1/hook_approve", "hook was called");
    assert(t.subject === "Approve test", "P1/hook_approve", "task created normally");
  } finally {
    clearAllHooks();
    cleanupTestDir(cwd);
  }
}

async function testP1_completed_hook_veto(): Promise<void> {
  const { createTask, claimTask, updateTask } = await import("../shared-tasks.js");
  const { registerTaskCompletedHook, clearAllHooks } = await import("../task-hooks.js");
  const cwd = createTestDir();
  const team = "hook-completed-team";

  try {
    const t1 = await createTask(cwd, team, "Complete veto test");
    await claimTask(cwd, team, t1.id, "agent-1");

    registerTaskCompletedHook(async (_task, _newStatus, _ctx) => {
      return { allowed: false, reason: "not done yet" };
    });

    // Completion vetoed → throws
    await assertThrows(
      () => updateTask(cwd, team, t1.id, { status: "completed" }),
      "P1/hook_completed", "completed hook veto throws",
    );
  } finally {
    clearAllHooks();
    cleanupTestDir(cwd);
  }
}

async function testP1_transition_hook(): Promise<void> {
  const { createTask, claimTask, updateTask } = await import("../shared-tasks.js");
  const { registerTaskTransitionHook, clearAllHooks } = await import("../task-hooks.js");
  const cwd = createTestDir();
  const team = "hook-trans-team";

  try {
    const transitions: [string, string][] = [];
    registerTaskTransitionHook(async (_task, from, to, _ctx) => {
      transitions.push([from, to]);
      return { allowed: true };
    });

    const t1 = await createTask(cwd, team, "Transition test");
    await claimTask(cwd, team, t1.id, "agent-1");
    // claimTask sets status to in_progress internally
    // Now update to completed
    await updateTask(cwd, team, t1.id, { status: "completed" });

    // Should have recorded the in_progress → completed transition
    // (claimTask sets pending→in_progress internally but may not go through updateTask hook path)
    const hasCompleted = transitions.some(([from, to]) => from === "in_progress" && to === "completed");
    assert(hasCompleted, "P1/hook_trans", "transition hook recorded in_progress→completed");
  } finally {
    clearAllHooks();
    cleanupTestDir(cwd);
  }
}

async function testP1_forceTaskStatus_bypasses_hooks(): Promise<void> {
  const { createTask, forceTaskStatus } = await import("../shared-tasks.js");
  const { registerTaskCompletedHook, clearAllHooks } = await import("../task-hooks.js");
  const cwd = createTestDir();
  const team = "force-bypass-team";

  try {
    // Register a hook that would normally veto all terminal transitions
    registerTaskCompletedHook(async (_task, _newStatus, _ctx) => {
      return { allowed: false, reason: "always veto" };
    });

    const t1 = await createTask(cwd, team, "Force test");

    // forceTaskStatus should bypass hooks (skipHooks=true)
    const result = await forceTaskStatus(cwd, team, t1.id, "failed", "test force");
    assert(result?.status === "failed", "P1/force_bypass", "forceTaskStatus bypasses hooks");
  } finally {
    clearAllHooks();
    cleanupTestDir(cwd);
  }
}

// ============================================================================
// P2 — Notification Tests
// ============================================================================

async function testP2_notify_task_assignment(): Promise<void> {
  const { writeToMailbox, readUnreadMessages, markMessageAsRead } = await import("../mailbox.js");
  const { notifyTaskAssignment } = await import("../task-notifications.js");
  type TaskNotification = import("../task-notifications.js").TaskNotification;
  const cwd = createTestDir();
  const team = "notif-assign-team";

  try {
    // Set up mailbox directory
    await notifyTaskAssignment(cwd, "agent-1", team, "1", "Test task", "team-lead");

    // Read agent-1's mailbox
    const msgs = await readUnreadMessages(cwd, "agent-1", team);
    assert(msgs.length > 0, "P2/notif_assign", "agent received notification");

    const msg = msgs[0]!;
    const parsed = JSON.parse(msg.text) as TaskNotification;
    assert(parsed.type === "task_assigned", "P2/notif_assign", "notification type is task_assigned");
    if (parsed.type === "task_assigned") {
      assert(parsed.taskId === "1", "P2/notif_assign", "taskId correct");
    } else {
      assert(false, "P2/notif_assign", "notification type is task_assigned");
    }
  } finally {
    cleanupTestDir(cwd);
  }
}

async function testP2_notify_task_unblocked(): Promise<void> {
  const { createTask, claimTask, updateTask, blockTask } = await import("../shared-tasks.js");
  const { readUnreadMessages } = await import("../mailbox.js");
  const cwd = createTestDir();
  const team = "notif-unblock-team";

  try {
    const t1 = await createTask(cwd, team, "Blocker");
    const t2 = await createTask(cwd, team, "Blocked", "", { blockedBy: [t1.id] });

    // Claim the blocked task so it has an owner
    // Need a different agent for t1 since claimTask checks busy
    const claimResult = await claimTask(cwd, team, t2.id, "agent-worker");
    // If claim failed because blockedBy, that's expected - let's update owner directly
    // Actually t2 is blocked by t1 which is pending, so claim should fail
    // Let's complete t1 first, then t2 becomes unblocked
    await claimTask(cwd, team, t1.id, "agent-1");
    await updateTask(cwd, team, t1.id, { status: "completed" });

    // Now t2 should be unblocked. The notification goes to team-lead by default
    // (since t2 has no owner yet)
    const msgs = await readUnreadMessages(cwd, "team-lead", team);
    assert(msgs.length > 0, "P2/notif_unblock", "team-lead received unblock notification");

    // Check notification content
    const notifMsg = msgs.find(m => {
      try {
        const p = JSON.parse(m.text);
        return p.type === "task_unblocked";
      } catch { return false; }
    });
    assert(notifMsg !== undefined, "P2/notif_unblock", "found task_unblocked notification");
  } finally {
    cleanupTestDir(cwd);
  }
}

async function testP2_verification_nudge(): Promise<void> {
  const { createTask, claimTask, updateTask } = await import("../shared-tasks.js");
  const { readUnreadMessages } = await import("../mailbox.js");
  const cwd = createTestDir();
  const team = "nudge-team";

  try {
    // Create and complete 4 tasks without verification keywords
    for (let i = 0; i < 4; i++) {
      const t = await createTask(cwd, team, `Build feature ${i}`);
      await claimTask(cwd, team, t.id, `agent-${i}`);
      await updateTask(cwd, team, t.id, { status: "completed" });
    }

    // Check team-lead mailbox for verification nudge
    const msgs = await readUnreadMessages(cwd, "team-lead", team);
    const nudgeMsg = msgs.find(m => {
      try {
        const p = JSON.parse(m.text);
        return p.type === "verification_nudge";
      } catch { return false; }
    });
    assert(nudgeMsg !== undefined, "P2/nudge", "verification nudge sent after 3+ completions");
  } finally {
    cleanupTestDir(cwd);
  }
}

// ============================================================================
// P3 — Progress Tests
// ============================================================================

async function testP3_progress_tracker(): Promise<void> {
  const {
    createProgressTracker, recordToolUse, recordTokenUsage, recordTurn,
    getProgressTracker, generateProgressSummary, generateCompactSummary,
    clearAllProgress,
  } = await import("../task-progress.js");

  try {
    const p = createProgressTracker("test-agent");

    recordToolUse("test-agent", "read");
    recordToolUse("test-agent", "bash");
    recordTokenUsage("test-agent", { input: 100, output: 50 });
    recordTurn("test-agent");

    const tracker = getProgressTracker("test-agent");
    assert(tracker !== null, "P3/progress", "tracker exists");
    assert(tracker!.toolUseCount === 2, "P3/progress", "toolUseCount is 2");
    assert(tracker!.toolsUsed.includes("read"), "P3/progress", "toolsUsed has read");
    assert(tracker!.toolsUsed.includes("bash"), "P3/progress", "toolsUsed has bash");
    assert(tracker!.tokenUsage.input === 100, "P3/progress", "tokenUsage.input is 100");
    assert(tracker!.tokenUsage.output === 50, "P3/progress", "tokenUsage.output is 50");
    assert(tracker!.turnCount === 1, "P3/progress", "turnCount is 1");

    const summary = generateProgressSummary("test-agent");
    assert(summary.includes("2"), "P3/progress", "summary mentions tool count");

    const compact = generateCompactSummary("test-agent");
    assert(compact.includes("1 turns"), "P3/progress", "compact summary has turn count");
  } finally {
    clearAllProgress();
  }
}

async function testP3_progress_persistence(): Promise<void> {
  const {
    createProgressTracker, recordToolUse, recordTokenUsage,
    persistProgress, clearAllProgress, loadProgress, removeProgressTracker,
  } = await import("../task-progress.js");
  const cwd = createTestDir();
  const team = "persist-team";

  try {
    const p = createProgressTracker("persist-agent");
    recordToolUse("persist-agent", "read");
    recordToolUse("persist-agent", "edit");
    recordTokenUsage("persist-agent", { input: 500 });

    assert(p.toolUseCount === 2, "P3/persist", "before persist: toolUseCount=2");

    // Persist to disk
    persistProgress(cwd, "persist-agent", team);

    // Clear in-memory
    clearAllProgress();

    // Load from disk
    const loaded = loadProgress(cwd, "persist-agent", team);
    assert(loaded !== null, "P3/persist", "loaded from disk");
    assert(loaded!.toolUseCount === 2, "P3/persist", "toolUseCount preserved after reload");
    assert(loaded!.toolsUsed.includes("read"), "P3/persist", "toolsUsed preserved");
    assert(loaded!.tokenUsage.input === 500, "P3/persist", "tokenUsage preserved");
  } finally {
    clearAllProgress();
    cleanupTestDir(cwd);
  }
}

async function testP3_progress_ring_buffer(): Promise<void> {
  const { createProgressTracker, recordToolUse, getProgressTracker, clearAllProgress } = await import("../task-progress.js");

  try {
    createProgressTracker("ring-agent");

    // Add 60 tool uses (MAX_ACTIVITY_ENTRIES = 50)
    for (let i = 0; i < 60; i++) {
      recordToolUse("ring-agent", `tool-${i}`);
    }

    const tracker = getProgressTracker("ring-agent");
    assert(tracker !== null, "P3/ringbuf", "tracker exists");
    assert(tracker!.activities.length <= 50, "P3/ringbuf", "activities trimmed to max 50");
    assert(tracker!.toolUseCount === 60, "P3/ringbuf", "total count still 60");
  } finally {
    clearAllProgress();
  }
}

// ============================================================================
// P4 — Foreground/Background Tests
// ============================================================================

async function testP4_display_state_lifecycle(): Promise<void> {
  const {
    createDisplayState, getDisplayState, backgroundTask, foregroundTask,
    isForeground, clearAllDisplayStates,
  } = await import("../task-foreground.js");

  try {
    const state = createDisplayState("task-1");
    assert(state.isForeground === true, "P4/lifecycle", "initially foreground");
    assert(isForeground("task-1") === true, "P4/lifecycle", "isForeground confirms");

    // Background
    const bgResult = backgroundTask("task-1");
    assert(bgResult.success === true, "P4/lifecycle", "background succeeds");
    assert(isForeground("task-1") === false, "P4/lifecycle", "now background");
    assert(getDisplayState("task-1")!.backgroundedAt !== undefined, "P4/lifecycle", "backgroundedAt set");

    // Foreground again
    const fgResult = foregroundTask("task-1");
    assert(fgResult.success === true, "P4/lifecycle", "foreground succeeds");
    assert(isForeground("task-1") === true, "P4/lifecycle", "now foreground again");

    // Already foreground → fails
    const fgResult2 = foregroundTask("task-1");
    assert(fgResult2.success === false, "P4/lifecycle", "already foreground → fail");
    assert(fgResult2.reason === "already_foreground", "P4/lifecycle", "reason correct");
  } finally {
    clearAllDisplayStates();
  }
}

async function testP4_mark_completed_evict(): Promise<void> {
  const {
    createDisplayState, markCompleted, getDisplayState, clearAllDisplayStates,
  } = await import("../task-foreground.js");

  try {
    createDisplayState("task-evict", { retain: true, evictAfterMs: 100 });
    markCompleted("task-evict");

    // Should still exist immediately
    assert(getDisplayState("task-evict") !== null, "P4/evict", "exists right after completion");

    // Wait for evict (100ms + margin)
    await new Promise(r => setTimeout(r, 250));

    // Should be evicted
    assert(getDisplayState("task-evict") === null, "P4/evict", "evicted after timeout");
  } finally {
    clearAllDisplayStates();
  }
}

async function testP4_background_all(): Promise<void> {
  const {
    createDisplayState, backgroundAll, getForegroundTasks,
    clearAllDisplayStates,
  } = await import("../task-foreground.js");

  try {
    createDisplayState("t1");
    createDisplayState("t2");
    createDisplayState("t3");

    assert(getForegroundTasks().length === 3, "P4/bg_all", "3 foreground tasks");

    const count = backgroundAll();
    assert(count === 3, "P4/bg_all", "backgroundAll returns 3");
    assert(getForegroundTasks().length === 0, "P4/bg_all", "no foreground tasks left");
  } finally {
    clearAllDisplayStates();
  }
}

async function testP4_failed_task_evict_delay(): Promise<void> {
  const {
    createDisplayState, markCompleted, getDisplayState, clearAllDisplayStates,
  } = await import("../task-foreground.js");

  try {
    // Failed tasks get 2x evict delay
    createDisplayState("task-fail", { retain: true, evictAfterMs: 100 });
    markCompleted("task-fail", { failed: true });

    // After 120ms (past normal 100ms), should still exist (2x delay = 200ms)
    await new Promise(r => setTimeout(r, 120));
    assert(getDisplayState("task-fail") !== null, "P4/fail_delay", "still exists at 1.2x normal delay");

    // After another 150ms (total ~270ms, well past 200ms), should be evicted
    await new Promise(r => setTimeout(r, 150));
    assert(getDisplayState("task-fail") === null, "P4/fail_delay", "evicted after 2x delay");
  } finally {
    clearAllDisplayStates();
  }
}

// ============================================================================
// P5-P8 — Compile & Constants Tests
// ============================================================================

async function testP5_P8_compile_and_constants(): Promise<void> {
  const RUNTIME_DEPS = ["typebox", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core"];
  function isRuntimeDep(err: any): boolean {
    const msg = err?.message || "";
    // ESM throws ERR_MODULE_NOT_FOUND; CJS throws MODULE_NOT_FOUND. Accept both.
    return ["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"].includes(err?.code) && RUNTIME_DEPS.some(d => msg.includes(d));
  }

  // P5: Task tools compile (may need typebox — provided by pi runtime)
  try {
    const createTool = await import("../task-create-tool.js");
    assert(createTool !== null, "P5/compile", "task-create-tool imports");
  } catch (err: any) {
    if (isRuntimeDep(err)) { log("P5", "task-create-tool skipped (needs typebox — provided by pi runtime)"); }
    else { assert(false, "P5/compile", "task-create-tool: " + err.message); }
  }

  try {
    const updateTool = await import("../task-update-tool.js");
    assert(updateTool !== null, "P5/compile", "task-update-tool imports");
  } catch (err: any) {
    if (isRuntimeDep(err)) { log("P5", "task-update-tool skipped (needs typebox)"); }
    else { assert(false, "P5/compile", "task-update-tool: " + err.message); }
  }

  try {
    const outputTool = await import("../task-output-tool.js");
    assert(outputTool !== null, "P5/compile", "task-output-tool imports");
  } catch (err: any) {
    if (isRuntimeDep(err)) { log("P5", "task-output-tool skipped (needs typebox)"); }
    else { assert(false, "P5/compile", "task-output-tool: " + err.message); }
  }

  try {
    const listTool = await import("../task-list-tool.js");
    assert(listTool !== null, "P5/compile", "task-list-tool imports");
  } catch (err: any) {
    if (isRuntimeDep(err)) { log("P5", "task-list-tool skipped (needs typebox)"); }
    else { assert(false, "P5/compile", "task-list-tool: " + err.message); }
  }

  // P6: Task resume compiles (may need pi-tui)
  try {
    const resume = await import("../task-resume.js");
    assert(resume !== null, "P6/compile", "task-resume imports");
  } catch (err: any) {
    if (isRuntimeDep(err)) { log("P6", "task-resume skipped (needs runtime dep)"); }
    else { assert(false, "P6/compile", "task-resume: " + err.message); }
  }

  // P7: Result storage compiles and constants (no external deps)
  const resultStorage = await import("../task-result-storage.js");
  assert(resultStorage !== null, "P7/compile", "task-result-storage imports");
  assert(resultStorage.PER_AGENT_INLINE_LIMIT === 50_000, "P7/constants", "PER_AGENT_INLINE_LIMIT is 50_000");

  // P8: Task render compiles (may need pi-tui)
  try {
    const render = await import("../task-render.js");
    assert(render !== null, "P8/compile", "task-render imports");
  } catch (err: any) {
    if (isRuntimeDep(err)) { log("P8", "task-render skipped (needs pi-tui)"); }
    else { assert(false, "P8/compile", "task-render: " + err.message); }
  }

  // Agent status compiles (no external deps)
  const agentStatus = await import("../agent-status.js");
  assert(agentStatus !== null, "P1/compile", "agent-status imports");

  // Task distributor compiles (no external deps)
  const distributor = await import("../task-distributor.js");
  assert(distributor !== null, "P2/compile", "task-distributor imports");

  // Lead poller compiles (no external deps)
  const leadPoller = await import("../lead-poller.js");
  assert(leadPoller !== null, "P2/compile", "lead-poller imports");
}

// ============================================================================
// CRITICAL — Compile All Modules (must always pass)
// ============================================================================

async function test_compile_all_modules(): Promise<void> {
  const RUNTIME_DEPS = ["typebox", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core"];
  function isRuntimeDep(err: any): boolean {
    const msg = err?.message || "";
    // ESM throws ERR_MODULE_NOT_FOUND; CJS throws MODULE_NOT_FOUND. Accept both.
    return ["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"].includes(err?.code) && RUNTIME_DEPS.some(d => msg.includes(d));
  }

  const aimDir = path.resolve(__dirname, "..");
  const files = fs.readdirSync(aimDir).filter(f => f.endsWith(".ts") && !f.endsWith(".d.ts"));

  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;
  const failDetails: string[] = [];

  for (const tsFile of files) {
    const moduleName = tsFile.replace(/\.ts$/, ".js");
    try {
      await import(`../${moduleName}`);
      successCount++;
    } catch (err: any) {
      if (isRuntimeDep(err)) {
        skipCount++;
      } else {
        failCount++;
        const msg = (err?.message ?? String(err)).split("\n")[0].substring(0, 150);
        failDetails.push(`${tsFile}: ${msg}`);
      }
    }
  }

  assert(failCount === 0, "COMPILE/all", `${failCount} module(s) failed to compile:\n${failDetails.join("\n")}`);
  assert(successCount + skipCount > 0, "COMPILE/all", "at least one module checked");
  log("COMPILE", `${successCount} ✅ OK | ${skipCount} ⏭️ Skipped (runtime deps) | ${failCount} ❌ FAIL`);
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function main(): Promise<void> {
  console.log("\n🧪 AIM Task System Test Suite (P0-P8)\n");
  const startTime = Date.now();

  // ALWAYS run compile check FIRST — if this fails, everything else is suspect
  log("COMPILE", "=== Compile Check (CRITICAL) ===");
  await test_compile_all_modules();

  // P0 Tests
  console.log("\n📦 P0 — Foundation Tests");
  await testP0_types_and_state_machine();
  await testP0_create_task();
  await testP0_highwatermark();
  await testP0_bidirectional_deps();
  await testP0_blockTask_validation();
  await testP0_delete_task_cleans_deps();
  await testP0_update_task_state_machine();
  await testP0_terminal_state_protection();
  await testP0_claimTask();
  await testP0_findAvailableTask();

  // P1 Tests
  console.log("\n🪝 P1 — Hook Tests");
  await testP1_created_hook_veto();
  await testP1_created_hook_approve();
  await testP1_completed_hook_veto();
  await testP1_transition_hook();
  await testP1_forceTaskStatus_bypasses_hooks();

  // P2 Tests
  console.log("\n📬 P2 — Notification Tests");
  await testP2_notify_task_assignment();
  await testP2_notify_task_unblocked();
  await testP2_verification_nudge();

  // P3 Tests
  console.log("\n📊 P3 — Progress Tests");
  await testP3_progress_tracker();
  await testP3_progress_persistence();
  await testP3_progress_ring_buffer();

  // P4 Tests
  console.log("\n🖥️ P4 — Foreground/Background Tests");
  await testP4_display_state_lifecycle();
  await testP4_mark_completed_evict();
  await testP4_background_all();
  await testP4_failed_task_evict_delay();

  // P5-P8 Tests
  console.log("\n🔧 P5-P8 — Compile & Constants");
  await testP5_P8_compile_and_constants();

  // Summary
  const elapsed = Date.now() - startTime;
  console.log("\n" + "=".repeat(60));
  console.log(`📊 Test Results: ${passCount}/${testCount} passed, ${failCount} failed (${elapsed}ms)`);
  if (failures.length > 0) {
    console.log("\n❌ Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log("=".repeat(60));

  if (failCount > 0) {
    process.exit(1);
  } else {
    console.log("✅ All tests passed!\n");
  }
}

main().catch(err => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
