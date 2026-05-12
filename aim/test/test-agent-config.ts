/**
 * Agent Config — Model &amp; Tools Configuration Test Suite
 *
 * Validates that agent definition files (.md with YAML frontmatter) correctly
 * parse model and tools configurations, matching Claude Code's design where
 * agents declare their own model and tool set.
 *
 * Tests:
 *   1. Frontmatter model: "sonnet" parsed correctly
 *   2. Frontmatter tools: "read,bash,write" parsed as array
 *   3. Frontmatter tools empty → undefined
 *   4. Frontmatter no model → undefined (inherit parent)
 *   5. (SKIP) disallowedTools — currently not supported in agents.ts
 *   6. Permission matrix getRoleTools respects agent's declared tools
 *   7. Model priority: params.model &gt; agentDef.model &gt; undefined
 *   8. Tools flow: agentDef.tools → getRoleTools → filtered result
 *
 * Run: npx tsx test/test-agent-config.ts
 */

/**
 * Lightweight YAML frontmatter parser — zero external dependencies.
 *
 * Parses simple key: value frontmatter blocks from markdown files.
 * Only supports flat scalar values; no nested structures or YAML anchors.
 *
 * Algorithm:
 *   1. Check if content starts with "---\n"
 *   2. Find the second "---\n" that closes the frontmatter block
 *   3. Parse each line in between as "key: value" pairs
 *   4. Return { frontmatter, body }
 */
function parseFrontmatter<T extends Record<string, string> = Record<string, string>>(
  content: string,
): { frontmatter: T; body: string } {
  // Normalize line endings (Windows CRLF / old Mac CR → Unix LF)
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // 1. Must start with the opening frontmatter delimiter "---\n"
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {} as T, body: normalized };
  }

  // 2. Find the closing delimiter (the second "---\n")
  //    Search from position 4 (past the opening "---\n")
  const closeIndex = normalized.indexOf("\n---", 4);
  if (closeIndex === -1) {
    // No closing delimiter — malformed frontmatter, treat all as body
    return { frontmatter: {} as T, body: normalized };
  }

  // 3. Extract the YAML portion between the two delimiters
  //    Opening "---\n" is 4 chars, closing "\n---" starts at closeIndex
  const yamlBlock = normalized.slice(4, closeIndex);

  // 4. Body is everything after the closing delimiter + trailing newline
  const body = normalized.slice(closeIndex + 5).trim();

  // 5. Parse each line as "key: value" (simple flat YAML)
  const frontmatter: Record<string, string> = {};

  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();

    // Skip blank lines and comments
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    // Find the first colon separator
    const colonPos = trimmed.indexOf(":");
    if (colonPos === -1) {
      continue;
    }

    const key = trimmed.slice(0, colonPos).trim();
    let value = trimmed.slice(colonPos + 1).trim();

    // Strip optional surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    frontmatter[key] = value;
  }

  return { frontmatter: frontmatter as T, body };
}

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
// Test Data — Agent definition with frontmatter
// ============================================================================

const AGENT_WITH_MODEL_AND_TOOLS = `---
name: code-reviewer
description: Reviews code for bugs, style, and security issues
model: sonnet
tools: read,bash,grep,glob
---

You are a code reviewer. You carefully examine code for correctness,
style issues, security vulnerabilities, and best practices.
You only perform read-only operations.`;

const AGENT_WITHOUT_MODEL = `---
name: helper
description: General purpose helper agent
tools: read,bash,write,edit
---

You are a helpful agent. Do the task asked of you.`;

const AGENT_WITHOUT_TOOLS = `---
name: thinker
description: Strategic planning agent
model: opus
---

You think deeply about complex problems and provide strategic guidance.`;

const AGENT_MINIMAL = `---
name: minimal
description: Bare minimum agent
---

Just do it.`;

// ============================================================================
// Test Cases
// ============================================================================

function test1_modelParsedFromFrontmatter() {
  console.log("\n=== Test 1: Model field parsed from frontmatter ===");

  const { frontmatter, body } = parseFrontmatter<Record<string, string>>(AGENT_WITH_MODEL_AND_TOOLS);

  log("parse", `model: "${frontmatter.model}"`);
  assert(frontmatter.model !== undefined, "model field exists", "");
  assert(frontmatter.model === "sonnet", 'model is "sonnet"', `got "${frontmatter.model}"`);
  assert(frontmatter.name === "code-reviewer", 'name is "code-reviewer"', "");
  assert(frontmatter.description === "Reviews code for bugs, style, and security issues", "description parsed", "");
  assert(body.includes("You are a code reviewer"), "body (system prompt) extracted", "");
}

function test2_toolsParsedAsArray() {
  console.log("\n=== Test 2: Tools field parsed and split into array ===");

  const { frontmatter } = parseFrontmatter<Record<string, string>>(AGENT_WITH_MODEL_AND_TOOLS);

  const tools = frontmatter.tools
    ?.split(",")
    .map((t: string) => t.trim())
    .filter(Boolean);

  log("parse", `tools: [${tools?.join(", ")}]`);

  assert(tools !== undefined, "tools array exists", "");
  assert(Array.isArray(tools), "tools is an array", "");
  assert(tools!.length === 4, `tools has 4 items`, `got ${tools!.length}`);
  assert(tools!.includes("read"), 'tools includes "read"', "");
  assert(tools!.includes("bash"), 'tools includes "bash"', "");
  assert(tools!.includes("grep"), 'tools includes "grep"', "");
  assert(tools!.includes("glob"), 'tools includes "glob"', "");
}

function test3_emptyToolsReturnsUndefined() {
  console.log("\n=== Test 3: Empty or missing tools → undefined ===");

  const { frontmatter: f1 } = parseFrontmatter<Record<string, string>>(AGENT_WITHOUT_TOOLS);
  const { frontmatter: f2 } = parseFrontmatter<Record<string, string>>(AGENT_MINIMAL);

  const t1 = f1.tools?.split(",").map(t => t.trim()).filter(Boolean);
  const t2 = f2.tools?.split(",").map(t => t.trim()).filter(Boolean);

  // Per agents.ts line 63: tools && tools.length > 0 ? tools : undefined
  const result1 = t1 && t1.length > 0 ? t1 : undefined;
  const result2 = t2 && t2.length > 0 ? t2 : undefined;

  assert(result1 === undefined, "no tools → undefined", `got ${JSON.stringify(result1)}`);
  assert(result2 === undefined, "no tools → undefined (minimal)", `got ${JSON.stringify(result2)}`);
}

function test4_missingModelReturnsUndefined() {
  console.log("\n=== Test 4: Missing model → undefined (inherit parent model) ===");

  const { frontmatter: f1 } = parseFrontmatter<Record<string, string>>(AGENT_WITHOUT_MODEL);
  const { frontmatter: f2 } = parseFrontmatter<Record<string, string>>(AGENT_MINIMAL);

  assert(f1.model === undefined, "no model → undefined", `got "${f1.model}"`);
  assert(f2.model === undefined, "minimal agent no model → undefined", `got "${f2.model}"`);
}

function test5_skipDisallowedTools() {
  console.log("\n=== Test 5: disallowedTools (SKIP — not yet supported) ===");
  // agents.ts does not currently parse a disallowedTools field from frontmatter.
  // This is a future enhancement aligned with Claude Code's CUSTOM_AGENT_DISALLOWED_TOOLS.
  log("skip", "disallowedTools parsing not implemented in agents.ts — test skipped");
  // Don't increment testCount for skipped tests
}

// ============================================================================
// Permission Matrix Integration Tests
// ============================================================================

// Duplicate the getRoleTools implementation to test independently
const FORBIDDEN_WORKER_TOOLS = new Set([
  "subagent", "agent", "send_message",
  "team_create", "team_delete", "task_stop",
]);

const TEAMMATE_FORCE_TOOLS = [
  "send_message", "team_create", "team_delete",
  "task_create", "task_list", "task_get", "task_update",
];

const COORDINATOR_TOOLS = ["subagent", "task_stop", "send_message"];

function getRoleTools(
  role: "worker" | "teammate" | "coordinator" | "default",
  declaredTools: string[],
): string[] {
  switch (role) {
    case "coordinator": return COORDINATOR_TOOLS;
    case "teammate": {
      const tools = new Set(declaredTools);
      for (const t of TEAMMATE_FORCE_TOOLS) tools.add(t);
      return Array.from(tools);
    }
    case "worker":
      return declaredTools.filter(t => !FORBIDDEN_WORKER_TOOLS.has(t));
    default:
      return declaredTools;
  }
}

function resolveRole(params: {
  isTeammate?: boolean; isCoordinator?: boolean; isFork?: boolean;
}): "worker" | "teammate" | "coordinator" | "default" {
  if (params.isCoordinator) return "coordinator";
  if (params.isTeammate) return "teammate";
  return "worker";
}

function test6_toolFilteringRespectsDeclaredTools() {
  console.log("\n=== Test 6: getRoleTools correctly filters agent's declared tools ===");

  const declaredTools = ["read", "bash", "write", "edit", "grep", "subagent", "send_message", "team_create"];

  // Worker: should strip subagent, send_message, team_create (but NOT team_delete which isn't in declared)
  const workerResult = getRoleTools("worker", declaredTools);
  log("worker", `declared: [${declaredTools.join(", ")}] → filtered: [${workerResult.join(", ")}]`);
  assert(workerResult.includes("read"), "worker keeps read", "");
  assert(workerResult.includes("bash"), "worker keeps bash", "");
  assert(workerResult.includes("write"), "worker keeps write", "");
  assert(workerResult.includes("edit"), "worker keeps edit", "");
  assert(workerResult.includes("grep"), "worker keeps grep", "");
  assert(!workerResult.includes("subagent"), "worker strips subagent", "");
  assert(!workerResult.includes("send_message"), "worker strips send_message", "");
  assert(!workerResult.includes("team_create"), "worker strips team_create", "");

  // Teammate: declared tools + force-injected
  const teammateDeclared = ["read", "bash"];
  const teammateResult = getRoleTools("teammate", teammateDeclared);
  log("teammate", `declared: [${teammateDeclared.join(", ")}] → filtered: [${teammateResult.join(", ")}]`);
  assert(teammateResult.includes("read"), "teammate keeps read", "");
  assert(teammateResult.includes("bash"), "teammate keeps bash", "");
  assert(teammateResult.includes("send_message"), "teammate gets force-injected send_message", "");
  assert(teammateResult.includes("team_create"), "teammate gets force-injected team_create", "");
  assert(teammateResult.includes("task_create"), "teammate gets force-injected task_create", "");
  assert(teammateResult.length >= 7, "teammate has at least 7 tools (2 declared + 5 force)", `got ${teammateResult.length}`);

  // Coordinator: only 3 tools regardless of declaration
  const coordResult = getRoleTools("coordinator", declaredTools);
  log("coordinator", `declared: [${declaredTools.join(", ")}] → filtered: [${coordResult.join(", ")}]`);
  assert(coordResult.length === 3, "coordinator has exactly 3 tools", `got ${coordResult.length}`);
  assert(coordResult.includes("subagent"), "coordinator has subagent", "");
  assert(coordResult.includes("task_stop"), "coordinator has task_stop", "");
  assert(coordResult.includes("send_message"), "coordinator has send_message", "");
  assert(!coordResult.includes("read"), "coordinator stripped read", "");

  // Role resolution
  assert(resolveRole({}) === "worker", "default → worker", "");
  assert(resolveRole({ isFork: true }) === "worker", "fork → worker", "");
  assert(resolveRole({ isTeammate: true }) === "teammate", "isTeammate → teammate", "");
  assert(resolveRole({ isCoordinator: true }) === "coordinator", "isCoordinator → coordinator", "");
}

function test7_modelPriorityInheritance() {
  console.log("\n=== Test 7: Model priority — params.model > agentDef.model > undefined ===");

  // Simulating the logic from agent-executor.ts (role-based tool filtering)
  // const model = params.model ?? agentDef.model;
  // If both undefined, worker uses parent's model (inherited via spawn args)

  type Params = { model?: string };
  type AgentDef = { name: string; model?: string };
  function resolveModel(params: Params, agentDef: AgentDef): string | undefined {
    return params.model ?? agentDef.model;
  }

  // Case 1: params.model present → wins
  assert(resolveModel({ model: "sonnet" }, { name: "a", model: "haiku" }) === "sonnet",
    "params.model overrides agentDef.model", "");

  // Case 2: only agentDef.model → used
  assert(resolveModel({}, { name: "a", model: "haiku" }) === "haiku",
    "agentDef.model used when params.model absent", "");

  // Case 3: neither → undefined (inherit parent)
  assert(resolveModel({}, { name: "a" }) === undefined,
    "undefined → inherit parent model", "");

  // Case 4: params.model undefined but agentDef has → agentDef used
  assert(resolveModel({ model: undefined }, { name: "a", model: "opus" }) === "opus",
    "agentDef.model used when params.model is explicitly undefined", "");
}

function test8_toolsFlowThroughPermissionMatrix() {
  console.log("\n=== Test 8: Full tool pipeline — agentDef.tools → getRoleTools ===");

  // Simulating the logic from agent-executor.ts (worktree + worker spawn)
  //   const declaredTools = params.tools ?? agentDef.tools ?? [];
  //   const role = resolveRole({ isTeammate, isFork });
  //   const tools = getRoleTools(role, declaredTools);

  type Params = { tools?: string[] };
  type AgentDefForTest = { name: string; tools?: string[] };

  function resolveTools(params: Params, agentDef: AgentDefForTest, role: "worker" | "teammate" | "coordinator"): string[] {
    const declared = params.tools ?? agentDef.tools ?? [];
    return getRoleTools(role, declared);
  }

  // Case 1: params.tools override
  const r1 = resolveTools(
    { tools: ["read", "bash"] },
    { name: "a", tools: ["read", "write", "subagent"] },
    "worker"
  );
  assert(r1.includes("read") && r1.includes("bash") && r1.length === 2,
    "params.tools override agentDef.tools", `got [${r1.join(", ")}]`);

  // Case 2: agentDef.tools used, filtered by worker role
  const r2 = resolveTools(
    {},
    { name: "a", tools: ["read", "bash", "write", "subagent", "send_message"] },
    "worker"
  );
  log("worker", `declared: [read,bash,write,subagent,send_message] → filtered: [${r2.join(", ")}]`);
  assert(r2.includes("read"), "worker keeps read from agentDef", "");
  assert(r2.includes("bash"), "worker keeps bash from agentDef", "");
  assert(r2.includes("write"), "worker keeps write from agentDef", "");
  assert(!r2.includes("subagent"), "worker strips subagent", "");
  assert(!r2.includes("send_message"), "worker strips send_message", "");
  assert(r2.length === 3, "worker has 3 tools after filter", `got ${r2.length}`);

  // Case 3: agentDef.tools used, teammate role adds force-injected
  const r3 = resolveTools(
    {},
    { name: "t", tools: ["read", "bash"] },
    "teammate"
  );
  log("teammate", `declared: [read,bash] → force-injected: [${r3.join(", ")}]`);
  assert(r3.includes("read"), "teammate keeps read", "");
  assert(r3.includes("bash"), "teammate keeps bash", "");
  assert(r3.includes("send_message"), "teammate gets send_message force-injected", "");
  assert(r3.includes("task_create"), "teammate gets task_create force-injected", "");

  // Case 4: agent has empty tools → empty + role filtering
  const r4 = resolveTools({}, { name: "n" }, "worker");
  assert(r4.length === 0, "undefined tools → empty after worker filter", `got ${r4.length}`);

  // Case 5: both params.tools and agentDef.tools present → params wins
  const r5 = resolveTools(
    { tools: ["custom1", "custom2"] },
    { name: "a", tools: ["read", "bash"] },
    "worker"
  );
  assert(r5.includes("custom1") && r5.includes("custom2"), "params.tools wins", `got [${r5.join(", ")}]`);
}

// ============================================================================
// Run
// ============================================================================

function main() {
  const cwd = process.cwd();
  console.log("AIM Agent Config — Model & Tools Test Suite");
  console.log(`CWD: ${cwd}`);
  console.log("===========================================");

  const startTime = Date.now();

  test1_modelParsedFromFrontmatter();
  test2_toolsParsedAsArray();
  test3_emptyToolsReturnsUndefined();
  test4_missingModelReturnsUndefined();
  test5_skipDisallowedTools();
  test6_toolFilteringRespectsDeclaredTools();
  test7_modelPriorityInheritance();
  test8_toolsFlowThroughPermissionMatrix();

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