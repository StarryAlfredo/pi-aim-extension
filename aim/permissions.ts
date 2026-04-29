/**
 * AIM — Permission Bridge
 *
 * Intercepts tool calls from subagents and requests user confirmation
 * for dangerous operations. Acts as a lightweight "permission gate"
 * between child agents and the user.
 *
 * Since Pi doesn't have a built-in permission system (by design), this
 * bridge uses ctx.ui.confirm() to ask the user for approval.
 *
 * Also handles fallback: if UI is not available (print/RPC mode),
 * auto-denies dangerous operations.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ============================================================================
// Dangerous Patterns
// ============================================================================

/** Commands that should always trigger a confirmation */
const DANGEROUS_COMMANDS = [
  /^rm\s+-rf\b/,
  /^rm\s+-r\b/,
  /^sudo\b/,
  /^chmod\s+777\b/,
  /^chown\b/,
  /^dd\s+if=/,
  /^mkfs\./,
  /^:\(\)\s*\{.*\}\s*;:/,  // fork bomb
  />\s*\/dev\/sd[a-z]/,
  /curl.*\|\s*(ba)?sh/,
  /wget.*\|\s*(ba)?sh/,
];

/** Commands that trigger a warning but are not blocked */
const WARN_COMMANDS = [
  /^git\s+push\s+--force/,
  /^git\s+reset\s+--hard/,
  /^npm\s+publish\b/,
  /^docker\s+(rm|rmi|system\s+prune)/,
];

// ============================================================================
// Registration
// ============================================================================

export function registerPermissions(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // Only intercept bash commands
    if (event.toolName !== "bash") return;

    const command = typeof event.input.command === "string" ? event.input.command : "";
    if (!command) return;

    // Check dangerous patterns
    const dangerous = DANGEROUS_COMMANDS.find((p) => p.test(command));
    if (dangerous) {
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "⚠️  Dangerous Command Detected",
          `The command:\n\n  ${command}\n\nis potentially destructive. Allow?`
        );
        if (!ok) return { block: true, reason: "Blocked by permission bridge — user denied." };
      } else {
        // No UI available → auto-deny
        return { block: true, reason: "Dangerous command blocked (no UI available for confirmation)." };
      }
    }

    // Check warning patterns
    const warn = WARN_COMMANDS.find((p) => p.test(command));
    if (warn && ctx.hasUI) {
      ctx.ui.notify(`⚠️  Potentially risky: ${command.slice(0, 60)}`, "warning");
    }
  });
}