/**
 * AIM — Permission Bridge
 *
 * Lightweight permission gate for dangerous bash commands.
 * Since pi doesn't have a built-in permission system, this uses
 * ctx.ui.confirm() for interactive approval. In headless mode
 * (print/RPC without UI), dangerous commands are auto-denied.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ============================================================================
// Dangerous Patterns
// ============================================================================

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