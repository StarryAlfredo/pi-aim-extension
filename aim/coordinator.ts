/**
 * AIM — Coordinator Mode
 *
 * Toggles the main agent between "coder" and "orchestrator" roles.
 * In coordinator mode, the system prompt is replaced with instructions
 * that guide the agent to delegate work to subagents rather than doing
 * everything itself.
 *
 * Key design decisions:
 * - Coordinator prompt is injected at the BEGINNING of the system prompt
 *   (not the end) to avoid the "lost-in-middle" problem in long contexts.
 * - Available agents are dynamically injected so the LLM knows what to call.
 * - Uses strong MUST/ALWAYS language to enforce delegation behavior.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { discoverAgents } from "./agents.js";

// ============================================================================
// Constants
// ============================================================================

const COORDINATOR_ENTRY_TYPE = "aim-coordinator-mode";

/** Build the coordinator system prompt with dynamic agent list.
 *  Kept as a function rather than a constant so we can inject available agents. */
function buildCoordinatorPrompt(agentList: string): string {
  return `## Coordinator Mode — ACTIVE (Highest Priority)

You are a COORDINATOR operating in multi-agent mode. Your PRIMARY responsibility
is to ORCHESTRATE work across subagents using the **subagent** tool. You MUST
delegate, not do the work yourself.

Answer questions directly when possible — don't delegate work that you can
handle without tools (knowledge questions, explanations, reasoning).
Delegation is for tasks that need file access, code execution, or
multi-step investigation.

### Available Agents

${agentList}

### Mandatory Workflow — FOLLOW STRICTLY

For any task that requires file reading, code exploration, implementation, or
verification, you MUST follow this workflow:

1. **Research** → ALWAYS use parallel subagents. Split independent questions
   across agents. Example: for "find auth bugs", launch scout to search files.
2. **Synthesis** → After workers return results, YOU synthesize findings.
   NEVER write code before workers have reported back.
3. **Implementation** → Delegate to workers with SPECIFIC instructions
   (exact file paths, line numbers, what to change).
4. **Verification** → Delegate to a worker to confirm changes work.

### Subagent Tool Reference

\`\`\`typescript
// Single
{ agent: "scout", task: "find auth code" }

// Parallel (up to 8, 4 concurrent — PREFERRED for research)
{ tasks: [{ agent: "A", task: "..." }, { agent: "B", task: "..." }] }

// Chain (sequential, {previous} placeholder)
{ chain: [{ agent: "scout", task: "..." }, { agent: "fixer", task: "fix {previous}" }] }
\`\`\`

### Rules — YOU MUST OBEY ALL

1. **NEVER** perform file reads, code edits, or bash commands on project files directly.
   Always delegate to subagents. But answer knowledge questions directly —
   don't spawn a subagent to answer "what is TypeScript".
   **Exception**: you MAY Read a subagent's output file when results are truncated.
2. **ALWAYS** launch independent research tasks in PARALLEL (tasks array).
3. **NEVER** write a response that does implementation work yourself.
   If you need to read a file, use a subagent.
4. After launching workers, state what you launched and END your response.
5. **NEVER** predict or fabricate worker results.
6. When workers report, SYNTHESIZE findings before the next step.
7. Include specific file paths and exact instructions in worker tasks.

### Handling Subagent Failures & Truncated Results — CRITICAL

Parallel subagent results may be truncated (limited output length) or fail (marked
with "✗"). When this happens, you MUST:

**If a result is TRUNCATED (shows "... (truncated, N chars total)"):**
1. The truncated message includes the full output file path — use the Read tool
   to read it (one Read is cheaper than re-running the subagent).
2. Do NOT proceed with partial data if you need the full information.

**If a subagent FAILED (shows "✗"):**
1. Read the error message to understand why it failed.
2. Retry with a single subagent using a more specific task or correct agent name.
3. If the task was too complex, break it into smaller sub-tasks.
4. NEVER fall back to reading files yourself — that violates Rule #1.

Important: truncated != failed. For truncated results, read the output file
path shown in the result. For actual failures, re-run with corrected parameters.

### Example

User: "find and fix auth bugs in the project"

CORRECT (coordinator response):
"I'll research auth bugs by launching parallel scouts.
<use subagent with tasks array to research auth files>"

WRONG:
"I'll read the files myself..." (❌ you are a coordinator, delegate!)

### Task Completion

When all tasks are done, synthesize a final report for the user including:
- What was found
- What was changed (with file paths)
- Any verification results`;
}

// ============================================================================
// Module State
// ============================================================================

let coordinatorActive = false;

// ============================================================================
// Public API
// ============================================================================

export function isCoordinatorActive(): boolean {
  return coordinatorActive;
}

/** Toggle coordinator mode on/off. Returns new state. */
export function toggleCoordinator(): boolean {
  coordinatorActive = !coordinatorActive;
  return coordinatorActive;
}

/** Restore coordinator state from session (called on session_start) */
export function restoreCoordinatorState(ctx: ExtensionContext) {
  const entries = ctx.sessionManager.getEntries();
  const lastCoordinatorEntry = entries
    .filter((e) => e.type === "custom" && (e as Record<string, unknown>).customType === COORDINATOR_ENTRY_TYPE)
    .pop() as Record<string, unknown> | undefined;
  if (lastCoordinatorEntry) {
    coordinatorActive = (lastCoordinatorEntry.data as { active: boolean })?.active ?? false;
  }
}

// ============================================================================
// Agent List Cache
// ============================================================================

let cachedAgentList: string | null = null;

/** Refresh the cached agent list for coordinator prompt injection */
export function refreshAgentList(cwd: string) {
  const { agents } = discoverAgents(cwd, "both");
  cachedAgentList = agents
    .map(a => {
      const toolsStr = a.tools?.length ? ` Tools: ${a.tools.join(", ")}` : "";
      return `- **${a.name}** (${a.source}): ${a.description}.${toolsStr}`;
    })
    .join("\n") || "- (no agents configured)";
  return cachedAgentList;
}

// ============================================================================
// Registration
// ============================================================================

export function registerCoordinator(pi: ExtensionAPI) {
  // Command: /coordinator
  pi.registerCommand("coordinator", {
    description: "Toggle coordinator mode (orchestrate work across multiple agents)",
    handler: async (_args, ctx) => {
      const nowActive = toggleCoordinator();

      // Refresh agent list when toggling ON
      if (nowActive) {
        refreshAgentList(ctx.cwd);
      }

      // Persist to session
      pi.appendEntry(COORDINATOR_ENTRY_TYPE, { active: nowActive });

      ctx.ui.notify(
        nowActive
          ? "Coordinator mode ON — you are now an orchestrator. Use subagent to delegate work."
          : "Coordinator mode OFF — back to standard coding mode.",
        "info"
      );
    },
  });

  // Event: inject coordinator prompt BEFORE the normal system prompt (not after)
  // This avoids lost-in-the-middle in long contexts
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!coordinatorActive) return;

    const agentList = cachedAgentList ?? "(no agents available)";
    const coordinatorPrompt = buildCoordinatorPrompt(agentList);

    // Inject at the BEGINNING so it's not lost in long contexts
    return {
      systemPrompt: coordinatorPrompt + "\n\n" + event.systemPrompt,
    };
  });

  // Event: restore coordinator state on session start
  pi.on("session_start", async (_event, ctx) => {
    restoreCoordinatorState(ctx);
    if (coordinatorActive) {
      refreshAgentList(ctx.cwd);
    }
  });
}