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
 *
 * Refactor: previously this module held three module-level mutable globals
 * (`coordinatorActive`, `cachedAgentList`, `cachedTemplate`) — a class
 * pretending to be a module. They are now encapsulated in the `Coordinator`
 * class, with a single module-level instance exported for convenience
 * (the extension is single-session, so one instance is correct).
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

/** Fallback prompt if the external template file is missing */
const FALLBACK_TEMPLATE = `## Coordinator Mode — ACTIVE (Highest Priority)

You are a COORDINATOR operating in multi-agent mode. Your PRIMARY responsibility
is to ORCHESTRATE work across subagents using the **subagent** tool. You MUST
delegate, not do the work yourself.

### Available Agents

{{AGENT_LIST}}

Delegate tasks to subagents. Use parallel mode for independent research.
Do NOT read/edit files yourself — delegate everything.`;

// ============================================================================
// Coordinator Class
// ============================================================================

/**
 * Encapsulates all coordinator-mode state: the active toggle, the cached
 * agent list (refreshed on toggle-on), and the cached prompt template
 * (loaded once from prompts/coordinator.md).
 */
export class Coordinator {
  private active = false;
  private cachedAgentList: string | null = null;
  private template: string = FALLBACK_TEMPLATE;

  isActive(): boolean {
    return this.active;
  }

  /** Toggle coordinator mode on/off. Returns the new state. */
  toggle(): boolean {
    this.active = !this.active;
    return this.active;
  }

  /** Restore coordinator state from session (called on session_start). */
  restoreState(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getEntries();
    const lastCoordinatorEntry = entries
      .filter((e): e is CustomEntry<unknown> => e.type === "custom" && e.customType === COORDINATOR_ENTRY_TYPE)
      .pop();
    if (lastCoordinatorEntry) {
      this.active = (lastCoordinatorEntry.data as { active: boolean } | undefined)?.active ?? false;
    }
  }

  /** Refresh the cached agent list for coordinator prompt injection. */
  refreshAgentList(cwd: string): string {
    const { agents } = discoverAgents(cwd, "both");
    this.cachedAgentList = agents
      .map(a => {
        const toolsStr = a.tools?.length ? ` Tools: ${a.tools.join(", ")}` : "";
        return `- **${a.name}** (${a.source}): ${a.description}.${toolsStr}`;
      })
      .join("\n") || "- (no agents configured)";
    return this.cachedAgentList;
  }

  /**
   * Load the coordinator prompt template from the external markdown file.
   * Caches the result after first successful load.
   * Falls back to a minimal inline prompt if the file is missing.
   *
   * Uses import.meta.url (ESM) for path resolution since this project
   * uses nodenext module resolution with .js import specifiers.
   */
  private loadTemplate(): string {
    if (this.template !== FALLBACK_TEMPLATE) return this.template;
    try {
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const templatePath = path.join(thisDir, "prompts", "coordinator.md");
      this.template = fs.readFileSync(templatePath, "utf-8");
      return this.template;
    } catch {
      console.warn("[aim] coordinator.md template not found, using fallback");
      return this.template;
    }
  }

  /** Build the coordinator system prompt with dynamic agent list. */
  private buildPrompt(agentList: string): string {
    const template = this.loadTemplate();
    return template.replace(/\{\{AGENT_LIST\}\}/g, agentList);
  }

  /**
   * Register the coordinator command and event handlers with pi.
   * Called once during extension initialization.
   */
  register(pi: ExtensionAPI): void {
    // Command: /coordinator
    pi.registerCommand("coordinator", {
      description: "Toggle coordinator mode (orchestrate work across multiple agents)",
      handler: async (_args, ctx) => {
        const nowActive = this.toggle();

        // Refresh agent list when toggling ON
        if (nowActive) {
          this.refreshAgentList(ctx.cwd);
        }

        // Persist to session
        pi.appendEntry(COORDINATOR_ENTRY_TYPE, { active: nowActive });

        ctx.ui.notify(
          nowActive
            ? "Coordinator mode ON — you are now an orchestrator. Use subagent to delegate work."
            : "Coordinator mode OFF — back to standard coding mode.",
          "info",
        );
      },
    });

    // Event: inject coordinator prompt BEFORE the normal system prompt (not after)
    // This avoids lost-in-the-middle in long contexts
    pi.on("before_agent_start", async (event, _ctx) => {
      if (!this.active) return;

      const agentList = this.cachedAgentList ?? "(no agents available)";
      const coordinatorPrompt = this.buildPrompt(agentList);

      // Inject at the BEGINNING so it's not lost in long contexts
      return {
        systemPrompt: coordinatorPrompt + "\n\n" + event.systemPrompt,
      };
    });

    // Event: restore coordinator state on session start
    pi.on("session_start", async (_event, ctx) => {
      this.restoreState(ctx);
      if (this.active) {
        this.refreshAgentList(ctx.cwd);
      }
    });
  }
}

// ============================================================================
// Module-level Singleton
// ============================================================================

/**
 * Single coordinator instance for the extension's lifetime.
 * The extension is single-session within a pi process, so one instance is
 * the correct cardinality — no need to key by cwd/team.
 */
export const coordinator = new Coordinator();

// ============================================================================
// Public API
// ============================================================================

/** Backward-compatible registration entry point. */
export function registerCoordinator(pi: ExtensionAPI): void {
  coordinator.register(pi);
}

// State accessors (kept for any external caller that previously used the
// module-level functions; they now delegate to the singleton).
export function isCoordinatorActive(): boolean {
  return coordinator.isActive();
}

export function toggleCoordinator(): boolean {
  return coordinator.toggle();
}

export function restoreCoordinatorState(ctx: ExtensionContext): void {
  coordinator.restoreState(ctx);
}

export function refreshAgentList(cwd: string): string {
  return coordinator.refreshAgentList(cwd);
}
