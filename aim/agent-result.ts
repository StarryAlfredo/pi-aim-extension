/**
 * AIM — Agent Result
 *
 * Formatting and aggregation helpers for AgentExecutionResult.
 * Extracted from subagent-tool.ts to centralize result presentation logic.
 *
 * These functions operate on the AgentExecutionResult type from agent-executor.ts,
 * providing leverage: callers don't need to know the internal structure of the
 * result to format it for display.
 */

import type { AgentExecutionResult, UsageSummary } from "./agent-executor.js";
import type { Message } from "@mariozechner/pi-ai";

// ============================================================================
// Message Output Extraction
// ============================================================================

/**
 * Extract the final output text from a list of messages.
 * Searches backwards for the last assistant message with text content.
 * Returns "" if no text output found.
 *
 * Moved from render.ts to break the circular import:
 *   agent-executor → render → agent-executor (type-only)
 * Now: agent-executor → agent-result (no cycle)
 */
export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

// ============================================================================
// Error Formatting
// ============================================================================

/**
 * Format an error message from an execution result.
 * Returns the most specific error information available.
 *
 * Priority: errorMessage > stderr > "(no output)"
 */
export function formatResultError(result: AgentExecutionResult): string {
  return result.errorMessage || result.stderr || "(no output)";
}

// ============================================================================
// Compact Formatting
// ============================================================================

/**
 * Format a result as a compact one-line summary.
 * Useful for parallel task displays and status bars.
 *
 * Format: ✓ agentName (1m 30s) | ✗ agentName [error]
 */
export function formatResultCompact(result: AgentExecutionResult): string {
  const icon = result.exitCode === 0 ? "✓" : result.exitCode === -1 ? "⏳" : "✗";
  const name = result.agentName || "unknown";
  if (result.exitCode === -1) {
    return `${icon} ${name} (running)`;
  }
  if (result.exitCode !== 0) {
    const err = result.errorMessage ? `: ${result.errorMessage.slice(0, 60)}` : "";
    return `${icon} ${name}${err}`;
  }
  const output = result.output ? ` — ${result.output.slice(0, 80)}` : "";
  return `${icon} ${name}${output}`;
}

// ============================================================================
// Usage Aggregation
// ============================================================================

/**
 * Aggregate token usage across multiple execution results.
 * Replaces inline reduce() calls in chain/parallel rendering.
 */
export function collectTotalUsage(results: AgentExecutionResult[]): UsageSummary {
  return results.reduce((sum, r) => ({
    input: sum.input + r.usage.input,
    output: sum.output + r.usage.output,
    cacheRead: sum.cacheRead + r.usage.cacheRead,
    cacheWrite: sum.cacheWrite + r.usage.cacheWrite,
    cost: sum.cost + r.usage.cost,
    contextTokens: sum.contextTokens + r.usage.contextTokens,
    turns: sum.turns + r.usage.turns,
  }), {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    cost: 0, contextTokens: 0, turns: 0,
  });
}
