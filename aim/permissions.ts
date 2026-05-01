/**
 * AIM — Permission Bridge
 *
 * Intercepts tool calls from subagents and requests user confirmation
 * for dangerous operations. Acts as a lightweight "permission gate"
 * between child agents and the user.
 *
 * Follows Claude Code's leaderPermissionBridge pattern:
 *   - Includes agent identity in confirmation dialogs
 *   - Auto-denies in headless mode
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getActiveTeam } from "./teams.js";

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
  /^:\(\)\s*\{.*\}\s*;:/,
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

export function isDangerous(command: string): RegExp | null {
  return DANGEROUS_COMMANDS.find((p) => p.test(command)) ?? null;
}

export function isWarning(command: string): boolean {
  return WARN_COMMANDS.some((p) => p.test(command));
}

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