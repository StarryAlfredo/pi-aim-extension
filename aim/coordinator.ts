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

import type { ExtensionAPI, ExtensionContext, CustomEntry } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgents } from "./agents.js";

// ============================================================================
// Constants
// ============================================================================

const COORDINATOR_ENTRY_TYPE = "aim-coordinator-mode";

// ============================================================================
// Template Loading
// ============================================================================

/** Fallback prompt if the external template file is missing */
const FALLBACK_TEMPLATE = `## Coordinator Mode — ACTIVE (Highest Priority)

You are a COORDINATOR operating in multi-agent mode. Your PRIMARY responsibility
is to ORCHESTRATE work across subagents using the **subagent** tool. You MUST
delegate, not do the work yourself.

### Available Agents

{{AGENT_LIST}}

Delegate tasks to subagents. Use parallel mode for independent research.
Do NOT read/edit files yourself — delegate everything.`;

/** Cached coordinator prompt template loaded from prompts/coordinator.md.
 *  Initialized to FALLBACK_TEMPLATE so the type is always string (no null). */
let cachedTemplate: string = FALLBACK_TEMPLATE;

/**
 * Load the coordinator prompt template from the external markdown file.
 * Caches the result after first successful load.
 * Falls back to a minimal inline prompt if the file is missing.
 *
 * Uses import.meta.url (ESM) for path resolution since this project
 * uses nodenext module resolution with .js import specifiers.
 */
function loadCoordinatorTemplate(): string {
  if (cachedTemplate !== FALLBACK_TEMPLATE) return cachedTemplate;
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const templatePath = path.join(thisDir, "prompts", "coordinator.md");
    cachedTemplate = fs.readFileSync(templatePath, "utf-8");
    return cachedTemplate;
  } catch {
    console.warn("[aim] coordinator.md template not found, using fallback");
    return cachedTemplate;
  }
}

/** Build the coordinator system prompt with dynamic agent list. */
function buildCoordinatorPrompt(agentList: string): string {
  const template = loadCoordinatorTemplate();
  return template.replace(/\{\{AGENT_LIST\}\}/g, agentList);
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
    .filter((e): e is CustomEntry<unknown> => e.type === "custom" && e.customType === COORDINATOR_ENTRY_TYPE)
    .pop();
  if (lastCoordinatorEntry) {
    coordinatorActive = (lastCoordinatorEntry.data as { active: boolean } | undefined)?.active ?? false;
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