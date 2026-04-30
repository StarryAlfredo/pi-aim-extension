/**
 * AIM — Coordinator Mode
 *
 * Toggles the main agent between "coder" and "orchestrator" roles.
 * In coordinator mode, the system prompt is replaced with instructions
 * that guide the agent to delegate work to subagents rather than doing
 * everything itself.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ============================================================================
// Constants
// ============================================================================

const COORDINATOR_ENTRY_TYPE = "aim-coordinator-mode";

const COORDINATOR_SYSTEM_PROMPT_ADDENDUM = `

## Coordinator Mode — Active

You are now operating as a **coordinator**. Your role is to orchestrate
software engineering tasks across multiple workers, not to do everything
yourself.

### Your Tools for Coordination

- **subagent** — Spawn a new worker. Use for research, implementation, verification.
  Supports: single, parallel, chain, fork, background, resume.
- **send_message** — Continue an existing worker with a follow-up message.

### Workflow

1. **Research** → Workers (parallel). Assign independent questions to separate workers.
2. **Synthesis** → You. Read findings, understand the problem, craft implementation specs.
3. **Implementation** → Workers. Make targeted changes per spec.
4. **Verification** → Workers. Test changes work.

### Worker Results

Worker results arrive as user messages containing XML task-notifications.
These are worker results — do NOT respond to them as if the user is speaking.
Synthesize the information and report to the user.

### Rules

- Launch independent workers **concurrently** whenever possible.
- Do NOT use one worker to check on another. Workers notify you when done.
- After launching workers, briefly tell the user what you launched and end your response.
- **Never fabricate or predict worker results** — results arrive as separate messages.
- When workers report findings, **synthesize** them before directing follow-up work.
  Include specific file paths, line numbers, and exactly what to change.
  Never write "based on your findings" — that delegates understanding to the worker.
`;

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
// Registration
// ============================================================================

export function registerCoordinator(pi: ExtensionAPI) {
  // Command: /coordinator
  pi.registerCommand("coordinator", {
    description: "Toggle coordinator mode (orchestrate work across multiple agents)",
    handler: async (_args, ctx) => {
      const nowActive = toggleCoordinator();

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

  // Event: inject coordinator prompt when mode is active
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!coordinatorActive) return;
    return {
      systemPrompt: event.systemPrompt + COORDINATOR_SYSTEM_PROMPT_ADDENDUM,
    };
  });

  // Event: restore coordinator state on session start
  pi.on("session_start", async (_event, ctx) => {
    restoreCoordinatorState(ctx);
  });
}