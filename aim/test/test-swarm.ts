/**
 * Swarm Commands & Message Router — Test Suite (TDD: expects FAILURE)
 *
 * Tests:
 *   1. @agent-name message router: parsing and routing logic
 *   2. /swarm commands: init, add, kill, list
 *
 * Run: npx tsx test/test-swarm.ts
 */

import * as path from "node:path";
import * as fs from "node:fs";

// ============================================================================
// Helpers
// ============================================================================

let testCount = 0, passCount = 0, failCount = 0;
const failures: string[] = [];

function assert(condition: boolean, test: string, detail: string) {
  if (condition) { passCount++; }
  else { failCount++; failures.push(test + ": " + detail); }
  testCount++;
}

function log(phase: string, msg: string) { console.log("  [" + phase + "] " + msg); }

// ============================================================================
// Module 1: @ Message Router
// ============================================================================

/**
 * Parse a user message looking for @agent-name prefixes.
 * Returns the parsed routing info, or null if no @-mention found.
 */
interface RoutedMessage {
  targets: string[];   // agent names mentioned
  content: string;     // message body without @-prefixes
  isBroadcast: boolean; // true if @all or @*
}

function parseMessageRouter(input: string, activeTeamAgents: string[]): RoutedMessage | null {
  // Match @agent-name at start of message or after newlines
  const atPattern = /@(\S+)(?:\s|$)/g;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = atPattern.exec(input)) !== null) {
    const name = match[1];
    if (name === "*" || name === "all") {
      return { targets: activeTeamAgents, content: input.replace(/@\S+\s*/g, "").trim(), isBroadcast: true };
    }
    if (activeTeamAgents.includes(name)) {
      mentions.push(name);
    }
  }

  if (mentions.length === 0) return null;
  const content = input.replace(/@\S+\s*/g, "").trim();
  return { targets: mentions, content, isBroadcast: false };
}

// ============================================================================
// Test Cases — Message Router
// ============================================================================

function test1_parseSingleMention() {
  console.log("\n=== Test 1: Parse single @agent mention ===");
  const agents = ["scout", "fixer", "reviewer"];

  const r = parseMessageRouter("@scout search for auth bugs", agents);
  assert(r !== null, "single mention parsed", "");
  assert(r?.targets.length === 1, "one target", "got " + (r?.targets.length ?? 0));
  assert(r?.targets[0] === "scout", "target is scout", r?.targets[0] ?? "");
  assert(r?.content === "search for auth bugs", "content extracted correctly", r?.content ?? "");
  assert(!r?.isBroadcast, "not broadcast", "");
}

function test2_parseMultipleMentions() {
  console.log("\n=== Test 2: Parse multiple @agent mentions ===");
  const agents = ["scout", "fixer", "reviewer"];

  const r = parseMessageRouter("@scout @fixer find and fix auth bug in login.ts", agents);
  assert(r !== null, "multiple mentions parsed", "");
  assert(r?.targets.length === 2, "two targets", "got " + (r?.targets.length ?? 0));
  assert(r?.targets.includes("scout"), "includes scout", "");
  assert(r?.targets.includes("fixer"), "includes fixer", "");
  assert(r?.content === "find and fix auth bug in login.ts", "content correct", r?.content ?? "");
}

function test3_parseBroadcastAll() {
  console.log("\n=== Test 3: Parse @all / @* broadcast ===");
  const agents = ["scout", "fixer", "reviewer"];

  const r1 = parseMessageRouter("@all stop all work", agents);
  assert(r1 !== null, "@all parsed", "");
  assert(r1?.isBroadcast, "@all is broadcast", "");
  assert(r1?.targets.length === 3, "@all targets all 3 agents", "got " + (r1?.targets.length ?? 0));

  const r2 = parseMessageRouter("@* shutdown immediately", agents);
  assert(r2 !== null, "@* parsed", "");
  assert(r2?.isBroadcast, "@* is broadcast", "");
}

function test4_parseNoMention() {
  console.log("\n=== Test 4: No @mention → return null (pass through) ===");
  const agents = ["scout", "fixer"];

  assert(parseMessageRouter("hello world", agents) === null, "no @mention → null", "");
  assert(parseMessageRouter("check @unknown stuff", agents) === null, "@unknown agent → null", "");
  assert(parseMessageRouter("", agents) === null, "empty input → null", "");
}

// ============================================================================
// Module 2: Swarm Commands (/swarm)
// ============================================================================

interface SwarmCommand {
  action: "init" | "add" | "kill" | "list" | "unknown";
  teamName?: string;
  agentType?: string;
  agentName?: string;
  description?: string;
}

function parseSwarmCommand(input: string): SwarmCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/swarm")) return null;

  const parts = trimmed.split(/\s+/);
  const action = parts[1];

  switch (action) {
    case "init":
      return { action: "init", teamName: parts[2], description: parts.slice(3).join(" ") || undefined };
    case "add":
      return { action: "add", agentType: parts[2], agentName: parts[3] };
    case "kill":
      return { action: "kill", agentName: parts[2] };
    case "list":
      return { action: "list" };
    default:
      return { action: "unknown" };
  }
}

// ============================================================================
// Test Cases — Swarm Commands
// ============================================================================

function test5_swarmInit() {
  console.log("\n=== Test 5: /swarm init <team> ===");
  const cmd = parseSwarmCommand("/swarm init myteam for code review");
  assert(cmd !== null, "init parsed", "");
  assert(cmd?.action === "init", "action is init", cmd?.action ?? "");
  assert(cmd?.teamName === "myteam", "team name parsed", cmd?.teamName ?? "");
  assert(cmd?.description === "for code review", "description parsed", cmd?.description ?? "");
}

function test6_swarmAdd() {
  console.log("\n=== Test 6: /swarm add <type> <name> ===");
  const cmd = parseSwarmCommand("/swarm add scout researcher-1");
  assert(cmd !== null, "add parsed", "");
  assert(cmd?.action === "add", "action is add", "");
  assert(cmd?.agentType === "scout", "agent type is scout", cmd?.agentType ?? "");
  assert(cmd?.agentName === "researcher-1", "agent name is researcher-1", cmd?.agentName ?? "");

  // Edge: extra whitespace
  const cmd2 = parseSwarmCommand("/swarm   add   fixer   bug-fixer   ");
  assert(cmd2?.agentType === "fixer", "whitespace handling", cmd2?.agentType ?? "");
  assert(cmd2?.agentName === "bug-fixer", "whitespace handling", cmd2?.agentName ?? "");
}

function test7_swarmKill() {
  console.log("\n=== Test 7: /swarm kill <name> ===");
  const cmd = parseSwarmCommand("/swarm kill researcher-1");
  assert(cmd !== null, "kill parsed", "");
  assert(cmd?.action === "kill", "action is kill", "");
  assert(cmd?.agentName === "researcher-1", "agent name parsed", cmd?.agentName ?? "");
}

function test8_swarmList() {
  console.log("\n=== Test 8: /swarm list ===");
  const cmd = parseSwarmCommand("/swarm list");
  assert(cmd !== null, "list parsed", "");
  assert(cmd?.action === "list", "action is list", "");
}

function test9_swarmEdgeCases() {
  console.log("\n=== Test 9: Edge cases ===");

  assert(parseSwarmCommand("hello") === null, "non-swarm input → null", "");
  assert(parseSwarmCommand("/swarm")?.action === "unknown", "bare /swarm → unknown", "");
  assert(parseSwarmCommand("/swarm bogus")?.action === "unknown", "unknown subcommand → unknown", "");
}

// ============================================================================
// Run
// ============================================================================

function main() {
  console.log("AIM Swarm Commands & Message Router — Test Suite");
  console.log("===========================================");

  test1_parseSingleMention();
  test2_parseMultipleMentions();
  test3_parseBroadcastAll();
  test4_parseNoMention();
  test5_swarmInit();
  test6_swarmAdd();
  test7_swarmKill();
  test8_swarmList();
  test9_swarmEdgeCases();

  console.log("\n===========================================");
  console.log("Results: " + passCount + "/" + testCount + " passed, " + failCount + " failed");
  if (failures.length > 0) { console.log("\nFailures:"); failures.forEach(function(f) { console.log("  X " + f); }); process.exit(1); }
  else { console.log("All tests passed!"); process.exit(0); }
}
main();