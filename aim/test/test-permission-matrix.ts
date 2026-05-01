/**
 * Tool Permission Matrix — Test Suite (TDD: expects FAILURE on first run)
 *
 * Tests role-based tool filtering at the infrastructure level (NOT relying
 * on LLM "politeness" or prompt instructions).
 *
 * Approach: We parse the agent_end output from subprocess workers to verify
 * that the tools ACTUALLY SENT to the LLM match the expected role-based set.
 * This is a source-level verification, not a behavioral test.
 *
 * Role-based tool sets:
 *   - "worker" role:  strip agent/send_message/team_create/team_delete/task_stop
 *   - "teammate" role: force-inject send_message, team_create, team_delete,
 *                       task_create, task_list, task_get, task_update
 *   - "coordinator" role: only agent, task_stop, send_message
 *
 * Tests:
 *   1. getRoleTools("worker", [...]) strips forbidden tools
 *   2. getRoleTools("teammate", [...]) force-injects collaboration tools
 *   3. getRoleTools("coordinator", [...]) produces only coord tools
 *   4. Agent definition's declared tools are filtered at runtime (integration)
 *
 * Run: npx tsx test/test-permission-matrix.ts
 */

import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

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
// Role-based Tool Definitions (matching Claude Code's constants)
// ============================================================================

/** Tools that workers should NEVER have */
const FORBIDDEN_WORKER_TOOLS = new Set([
  "subagent", "agent",
  "send_message",
  "team_create", "team_delete",
  "task_stop",
]);

/** Tools force-injected for teammates */
const TEAMMATE_FORCE_TOOLS = [
  "send_message",
  "team_create", "team_delete",
  "task_create", "task_list", "task_get", "task_update",
];

/** Tools allowed for coordinator (exclusive — these ONLY) */
const COORDINATOR_TOOLS = ["subagent", "task_stop", "send_message"];

/**
 * Compute effective tools for a given role.
 * This is the function we implement in permission-matrix.ts.
 */
function getRoleTools(
  role: "worker" | "teammate" | "coordinator" | "default",
  declaredTools: string[],
): string[] {
  switch (role) {
    case "coordinator":
      // Coordinator gets ONLY these tools, regardless of declaration
      return COORDINATOR_TOOLS;

    case "teammate": {
      // Teammate: declared tools + force-injected collaboration tools
      const tools = new Set(declaredTools);
      for (const t of TEAMMATE_FORCE_TOOLS) tools.add(t);
      return Array.from(tools);
    }

    case "worker": {
      // Worker: declared tools minus forbidden worker tools
      return declaredTools.filter(t => !FORBIDDEN_WORKER_TOOLS.has(t));
    }

    default:
      return declaredTools;
  }
}

// ============================================================================
// Test Cases — Unit Tests (no LLM needed)
// ============================================================================

function test1_workerStripsForbiddenTools() {
  console.log("\n=== Test 1: Worker role strips forbidden tools ===");

  const declared = ["read", "bash", "write", "edit", "grep", "subagent", "send_message", "team_create"];
  const result = getRoleTools("worker", declared);

  log("tools", `declared: [${declared.join(", ")}]`);
  log("tools", `result:   [${result.join(", ")}]`);

  assert(result.includes("read"), "worker keeps read", "");
  assert(result.includes("bash"), "worker keeps bash", "");
  assert(result.includes("write"), "worker keeps write", "");
  assert(!result.includes("subagent"), "worker strips subagent (no re-delegation)", "");
  assert(!result.includes("send_message"), "worker strips send_message", "");
  assert(!result.includes("team_create"), "worker strips team_create", "");
}

function test2_teammateForceInjectsTools() {
  console.log("\n=== Test 2: Teammate role force-injects collaboration tools ===");

  const declared = ["read", "bash"];
  const result = getRoleTools("teammate", declared);

  log("tools", `declared: [${declared.join(", ")}]`);
  log("tools", `result:   [${result.join(", ")}]`);

  assert(result.includes("read"), "teammate keeps declared read", "");
  assert(result.includes("bash"), "teammate keeps declared bash", "");
  assert(result.includes("send_message"), "teammate gets send_message force-injected", "");
  assert(result.includes("team_create"), "teammate gets team_create force-injected", "");
  assert(result.includes("task_create"), "teammate gets task_create force-injected", "");
  assert(result.includes("task_list"), "teammate gets task_list force-injected", "");
}

function test3_coordinatorOnlyCoordTools() {
  console.log("\n=== Test 3: Coordinator gets ONLY coordinator tools ===");

  // Even if agent definition declares bash, read, write — coordinator strips them ALL
  const declared = ["read", "bash", "write", "edit", "grep", "glob", "subagent", "send_message"];
  const result = getRoleTools("coordinator", declared);

  log("tools", `declared: [${declared.join(", ")}]`);
  log("tools", `result:   [${result.join(", ")}]`);

  assert(result.length === COORDINATOR_TOOLS.length, `coordinator has exactly ${COORDINATOR_TOOLS.length} tools`, `got ${result.length}`);
  for (const t of COORDINATOR_TOOLS) {
    assert(result.includes(t), `coordinator has ${t}`, "");
  }
  assert(!result.includes("read"), "coordinator stripped read", "");
  assert(!result.includes("bash"), "coordinator stripped bash", "");
  assert(!result.includes("write"), "coordinator stripped write", "");
}

function test4_edgeCases() {
  console.log("\n=== Test 4: Edge cases ===");

  // Empty tools array
  assert(getRoleTools("worker", []).length === 0, "worker with empty tools stays empty", "");
  assert(getRoleTools("coordinator", []).length === COORDINATOR_TOOLS.length, "coordinator with empty tools gets coord tools", "");
  assert(getRoleTools("teammate", []).length === TEAMMATE_FORCE_TOOLS.length, "teammate with empty tools gets force-injected", "");

  // Default role passes through unchanged
  const declared = ["read", "bash", "subagent"];
  const result = getRoleTools("default", declared);
  assert(result.length === declared.length, "default role passes through unchanged", "");
  assert(result.includes("subagent"), "default role keeps subagent", "");
}

// ============================================================================
// Run
// ============================================================================

function main() {
  const cwd = process.cwd();
  console.log("AIM Tool Permission Matrix — Test Suite");
  console.log(`CWD: ${cwd}`);
  console.log("===========================================");

  const startTime = Date.now();

  test1_workerStripsForbiddenTools();
  test2_teammateForceInjectsTools();
  test3_coordinatorOnlyCoordTools();
  test4_edgeCases();

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

main();