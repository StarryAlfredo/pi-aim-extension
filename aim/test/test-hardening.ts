/**
 * AIM — Hardening Tests
 *
 * Covers the security/correctness fixes from the 2026-06-18 review:
 *   - sanitizeId / path-traversal protection (types.ts)
 *   - lock.ts acquire/release + stale detection
 *   - task-hooks register/unregister (no accumulation)
 *   - shared-tasks createTask with traversal-rejecting task_id
 *
 * All tests are pure logic / real filesystem in a temp dir — no LLM subprocess.
 * Run: npx tsx test/test-hardening.ts
 */
export {};

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import { sanitizeId, getTasksDir } from "../types.js";
import { acquireFileLock } from "../lock.js";
import {
  createTask, deleteTask, claimTask, updateTask,
} from "../shared-tasks.js";
import {
  clearAllHooks,
  registerTaskCreatedHook, unregisterTaskCreatedHook,
  registerTaskCompletedHook, unregisterTaskCompletedHook,
  registerTaskTransitionHook, unregisterTaskTransitionHook,
  executeTaskCreatedHooks, executeTaskCompletedHooks, executeTaskTransitionHooks,
  type HookContext,
} from "../task-hooks.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Test helpers
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

function assertThrows(fn: () => unknown, test: string, detail: string): void {
  testCount++;
  try {
    fn();
    failCount++;
    failures.push(`${test}: ${detail} (expected throw, none happened)`);
  } catch {
    passCount++;
  }
}

async function assertThrowsAsync(fn: () => Promise<unknown>, test: string, detail: string): Promise<void> {
  testCount++;
  try {
    await fn();
    failCount++;
    failures.push(`${test}: ${detail} (expected throw, none happened)`);
  } catch {
    passCount++;
  }
}

function createTestDir(): string {
  const dir = path.join(os.tmpdir(), `aim-hardening-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, ".pi", "aim"), { recursive: true });
  return dir;
}

function cleanupTestDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ============================================================================
// Tests: sanitizeId / path traversal
// ============================================================================

function testSanitizeIdAcceptsValid(): void {
  assert(sanitizeId("abc123", "x") === "abc123", "sanitize/valid-alnum", "letters+digits accepted");
  assert(sanitizeId("task-1_foo", "x") === "task-1_foo", "sanitize/valid-dash-underscore", "dash/underscore accepted");
  assert(sanitizeId("019ed9e1-abc", "x") === "019ed9e1-abc", "sanitize/uuid-like", "uuid-like accepted");
}

function testSanitizeIdRejectsTraversal(): void {
  assertThrows(() => sanitizeId("../../etc/passwd", "task id"), "sanitize/reject-traversal", "should reject ../../");
  assertThrows(() => sanitizeId("..", "team name"), "sanitize/reject-dotdot", "should reject ..");
  assertThrows(() => sanitizeId("a/b", "team name"), "sanitize/reject-slash", "should reject path separator");
  assertThrows(() => sanitizeId("a\\b", "team name"), "sanitize/reject-backslash", "should reject backslash");
  assertThrows(() => sanitizeId("", "team name"), "sanitize/reject-empty", "should reject empty");
  assertThrows(() => sanitizeId("a.b", "team name"), "sanitize/reject-dot", "should reject dot (traversal risk)");
  assertThrows(() => sanitizeId("a b", "team name"), "sanitize/reject-space", "should reject space");
  // null/undefined safety
  assertThrows(() => sanitizeId(undefined as unknown as string, "team name"), "sanitize/reject-undefined", "should reject undefined");
}

function testGetTasksDirRejectsTraversal(): void {
  const cwd = createTestDir();
  try {
    assertThrows(() => getTasksDir(cwd, "../../etc"), "getTasksDir/reject-traversal", "should reject traversing team name");
    assertThrows(() => getTasksDir(cwd, "a/b"), "getTasksDir/reject-slash", "should reject slash in team name");
    // A clean team name must NOT throw.
    let threw = false;
    try { getTasksDir(cwd, "good-team"); } catch { threw = true; }
    assert(!threw, "getTasksDir/accept-clean", "clean team name should not throw");
  } finally {
    cleanupTestDir(cwd);
  }
}

// ============================================================================
// Tests: lock.ts
// ============================================================================

async function testLockAcquireRelease(): Promise<void> {
  const dir = createTestDir();
  try {
    const target = path.join(dir, "resource");
    const release = await acquireFileLock(target);
    assert(fs.existsSync(target + ".lock"), "lock/acquire", "lock file created");
    await release();
    assert(!fs.existsSync(target + ".lock"), "lock/release", "lock file removed on release");
  } finally {
    cleanupTestDir(dir);
  }
}

async function testLockSerializesAccess(): Promise<void> {
  const dir = createTestDir();
  try {
    const target = path.join(dir, "contended");
    const release = await acquireFileLock(target);

    // A second acquisition must wait (not acquire immediately). Give it a
    // short budget; it should still be pending when we check.
    let secondAcquired = false;
    const second = acquireFileLock(target).then(r => { secondAcquired = true; return r; });
    await new Promise(r => setTimeout(r, 150));
    assert(!secondAcquired, "lock/serializes", "second acquire should wait while first is held");
    await release();
    const release2 = await second; // now it should succeed
    assert(secondAcquired, "lock/serializes-after-release", "second acquire should succeed after release");
    await release2();
  } finally {
    cleanupTestDir(dir);
  }
}

async function testLockReleasesStale(): Promise<void> {
  // Simulate a stale lock by writing an old lock file, then acquiring.
  // We can't easily wait 10s in a unit test, so we backdate the mtime.
  const dir = createTestDir();
  try {
    const target = path.join(dir, "stale");
    const lockPath = target + ".lock";
    fs.writeFileSync(lockPath, "99999", { flag: "wx" });
    // Backdate mtime to 60s ago
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, oldTime, oldTime);

    // Should succeed quickly despite existing (stale) lock.
    const release = await Promise.race([
      acquireFileLock(target),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2_000)),
    ]);
    assert(typeof release === "function", "lock/stale-acquired", "stale lock should be force-released and acquired");
    await release();
  } finally {
    cleanupTestDir(dir);
  }
}

// ============================================================================
// Tests: hooks register/unregister (no accumulation)
// ============================================================================

async function testHooksRegisterReturnsId(): Promise<void> {
  clearAllHooks();
  const id = registerTaskCreatedHook(async () => ({ allowed: true }));
  assert(typeof id === "number" && id > 0, "hooks/register-returns-id", "register returns numeric id");
  unregisterTaskCreatedHook(id);
  clearAllHooks();
}

async function testHooksUnregisterPreventsExecution(): Promise<void> {
  clearAllHooks();
  let calls = 0;
  const id = registerTaskCreatedHook(async () => { calls++; return { allowed: true }; });
  const ctx: HookContext = { cwd: "/tmp", team: "t" };
  await executeTaskCreatedHooks({} as never, ctx);
  assert(calls === 1, "hooks/fires-before-unregister", "hook should fire once when registered");
  unregisterTaskCreatedHook(id);
  await executeTaskCreatedHooks({} as never, ctx);
  assert(calls === 1, "hooks/no-fire-after-unregister", "hook should NOT fire after unregister");
  clearAllHooks();
}

async function testHooksNoAccumulationAcrossRegistrations(): Promise<void> {
  clearAllHooks();
  let createdCalls = 0;
  let completedCalls = 0;
  let transitionCalls = 0;

  // Simulate repeated "reload" registrations
  for (let i = 0; i < 3; i++) {
    const a = registerTaskCreatedHook(async () => { createdCalls++; return { allowed: true }; });
    const b = registerTaskCompletedHook(async () => { completedCalls++; return { allowed: true }; });
    const c = registerTaskTransitionHook(async () => { transitionCalls++; return { allowed: true }; });
    // Properly unregister before "next reload" — a well-behaved caller.
    unregisterTaskCreatedHook(a);
    unregisterTaskCompletedHook(b);
    unregisterTaskTransitionHook(c);
  }
  const ctx: HookContext = { cwd: "/tmp", team: "t" };
  await executeTaskCreatedHooks({} as never, ctx);
  await executeTaskCompletedHooks({} as never, "completed", ctx);
  await executeTaskTransitionHooks({} as never, "pending", "in_progress", ctx);
  assert(createdCalls === 0, "hooks/no-created-accumulation", "created hook should not accumulate when unregistered");
  assert(completedCalls === 0, "hooks/no-completed-accumulation", "completed hook should not accumulate");
  assert(transitionCalls === 0, "hooks/no-transition-accumulation", "transition hook should not accumulate");
  clearAllHooks();
}

async function testHooksUnregisterReturnsFalseForUnknown(): Promise<void> {
  clearAllHooks();
  assert(unregisterTaskCreatedHook(999999) === false, "hooks/unregister-unknown-false", "unregister of unknown id should return false");
  const id = registerTaskCreatedHook(async () => ({ allowed: true }));
  assert(unregisterTaskCreatedHook(id) === true, "hooks/unregister-known-true", "unregister of known id should return true");
  assert(unregisterTaskCreatedHook(id) === false, "hooks/unregister-twice-false", "second unregister of same id should return false");
  clearAllHooks();
}

// ============================================================================
// Tests: shared-tasks rejects traversal task_id
// ============================================================================

async function testCreateTaskRejectsBadTeam(): Promise<void> {
  const cwd = createTestDir();
  try {
    await assertThrowsAsync(
      () => createTask(cwd, "../../etc", "subject", "desc"),
      "createTask/reject-traversal-team", "createTask should reject traversing team name",
    );
  } finally {
    cleanupTestDir(cwd);
  }
}

async function testCreateTaskRejectsBadTaskId(): Promise<void> {
  // createTask auto-generates a numeric id, so we can't inject a bad id directly.
  // Instead, exercise the read/update/delete paths with a malicious id and
  // confirm they throw (sanitizeId in taskFilePath guards them).
  const cwd = createTestDir();
  try {
    await createTask(cwd, "team", "subject", "desc"); // establishes the team dir
    await assertThrowsAsync(
      () => deleteTask(cwd, "team", "../../evil"),
      "deleteTask/reject-traversal-id", "deleteTask should reject traversing task id",
    );
    await assertThrowsAsync(
      () => updateTask(cwd, "team", "../../evil", { description: "x" }),
      "updateTask/reject-traversal-id", "updateTask should reject traversing task id",
    );
    await assertThrowsAsync(
      () => claimTask(cwd, "team", "../../evil", "agent"),
      "claimTask/reject-traversal-id", "claimTask should reject traversing task id",
    );
  } finally {
    cleanupTestDir(cwd);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const startTime = Date.now();

  testSanitizeIdAcceptsValid();
  testSanitizeIdRejectsTraversal();
  testGetTasksDirRejectsTraversal();

  await testLockAcquireRelease();
  await testLockSerializesAccess();
  await testLockReleasesStale();

  await testHooksRegisterReturnsId();
  await testHooksUnregisterPreventsExecution();
  await testHooksNoAccumulationAcrossRegistrations();
  await testHooksUnregisterReturnsFalseForUnknown();

  await testCreateTaskRejectsBadTeam();
  await testCreateTaskRejectsBadTaskId();

  const elapsed = Date.now() - startTime;
  console.log("\n" + "=".repeat(60));
  console.log(`📊 Hardening Tests: ${passCount}/${testCount} passed, ${failCount} failed (${elapsed}ms)`);
  if (failures.length > 0) {
    console.log("\n❌ Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log("=".repeat(60));

  if (failCount > 0) process.exit(1);
  else console.log("✅ All hardening tests passed!\n");
}

main().catch(err => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
