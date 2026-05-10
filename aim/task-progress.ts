/**
 * AIM — Task Progress Tracker (P3)
 *
 * Real-time progress tracking for subagent execution.
 * Tracks tool usage, token consumption, turn count, and activity log.
 *
 * Design mirrors Claude Code's ProgressTracker:
 *   - Per-task progress maintained in an in-memory Map
 *   - Progress is updated by worker-pool as it receives events
 *   - Progress can be persisted to disk for recovery after crashes
 *   - Progress summaries are available to TUI renderers and notifications
 *
 * Integration points:
 *   - worker-pool.ts: calls recordToolUse/recordTokenUsage on events
 *   - index.ts: creates tracker on agent spawn, reads on completion
 *   - render.ts / task-render.ts: displays progress in TUI
 *   - task-notifications.ts: includes progress in idle notifications
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getTasksDir } from "./types.js";
import type { Message } from "@mariozechner/pi-ai";

// ============================================================================
// Types
// ============================================================================

/** Token usage breakdown */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A single activity entry in the progress log */
export interface ActivityEntry {
  /** Timestamp (ms since epoch) */
  ts: number;
  /** Activity type */
  type: "tool_use" | "message" | "status_change" | "error";
  /** Human-readable detail */
  detail: string;
}

/** Progress snapshot for a single task/agent */
export interface TaskProgress {
  /** Task or agent ID this progress is associated with */
  id: string;
  /** Number of tool invocations */
  toolUseCount: number;
  /** Names of tools used (for display) */
  toolsUsed: string[];
  /** Accumulated token usage */
  tokenUsage: TokenUsage;
  /** Number of conversation turns (assistant messages) */
  turnCount: number;
  /** Activity log (capped at MAX_ACTIVITY_ENTRIES) */
  activities: ActivityEntry[];
  /** Timestamp of last activity */
  lastActivityAt: number;
  /** When tracking started */
  startedAt: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum activity entries to keep per task (ring buffer) */
const MAX_ACTIVITY_ENTRIES = 50;

/** Progress persistence file name */
const PROGRESS_FILE = "progress.json";

// ============================================================================
// In-Memory Registry
// ============================================================================

/** Active progress trackers, keyed by task/agent ID */
const activeProgress = new Map<string, TaskProgress>();

// ============================================================================
// Creation & Destruction
// ============================================================================

/**
 * Create a new progress tracker for a task/agent.
 * Returns the initialized progress object.
 */
export function createProgressTracker(id: string): TaskProgress {
  // If overwriting an existing tracker, remove it first to prevent stale data.
  // This can happen during resume or agent restart scenarios.
  if (activeProgress.has(id)) {
    console.warn(`[aim] Overwriting existing progress tracker for ${id}`);
    activeProgress.delete(id);
  }
  const now = Date.now();
  const progress: TaskProgress = {
    id,
    toolUseCount: 0,
    toolsUsed: [],
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    turnCount: 0,
    activities: [],
    lastActivityAt: now,
    startedAt: now,
  };
  activeProgress.set(id, progress);
  return progress;
}

/**
 * Remove a progress tracker from the in-memory registry.
 * Call after the task completes and progress has been persisted.
 */
export function removeProgressTracker(id: string): void {
  activeProgress.delete(id);
}

/**
 * Get an existing progress tracker, or null if not tracked.
 */
export function getProgressTracker(id: string): TaskProgress | null {
  return activeProgress.get(id) ?? null;
}

/**
 * Get all active progress trackers.
 */
export function getAllProgressTrackers(): TaskProgress[] {
  return Array.from(activeProgress.values());
}

// ============================================================================
// Recording
// ============================================================================

/**
 * Record a tool use event.
 * @param id Task/agent ID
 * @param toolName Name of the tool invoked
 */
export function recordToolUse(id: string, toolName: string): void {
  const p = activeProgress.get(id);
  if (!p) return;
  p.toolUseCount++;
  if (!p.toolsUsed.includes(toolName)) {
    p.toolsUsed.push(toolName);
  }
  p.activities.push({ ts: Date.now(), type: "tool_use", detail: toolName });
  trimActivities(p);
  p.lastActivityAt = Date.now();
}

/**
 * Record token usage from an API response.
 * Increments the running totals.
 * @param id Task/agent ID
 * @param usage Partial token usage to add
 */
export function recordTokenUsage(id: string, usage: Partial<TokenUsage>): void {
  const p = activeProgress.get(id);
  if (!p) return;
  if (usage.input !== undefined) p.tokenUsage.input += usage.input;
  if (usage.output !== undefined) p.tokenUsage.output += usage.output;
  if (usage.cacheRead !== undefined) p.tokenUsage.cacheRead += usage.cacheRead;
  if (usage.cacheWrite !== undefined) p.tokenUsage.cacheWrite += usage.cacheWrite;
  p.lastActivityAt = Date.now();
}

/**
 * Record a turn completion (one assistant message cycle).
 * @param id Task/agent ID
 */
export function recordTurn(id: string): void {
  const p = activeProgress.get(id);
  if (!p) return;
  p.turnCount++;
  p.lastActivityAt = Date.now();
}

/**
 * Record a status change event.
 * @param id Task/agent ID
 * @param detail Human-readable status description
 */
export function recordStatusChange(id: string, detail: string): void {
  const p = activeProgress.get(id);
  if (!p) return;
  p.activities.push({ ts: Date.now(), type: "status_change", detail });
  trimActivities(p);
  p.lastActivityAt = Date.now();
}

/**
 * Record an error event.
 * @param id Task/agent ID
 * @param detail Error description
 */
export function recordError(id: string, detail: string): void {
  const p = activeProgress.get(id);
  if (!p) return;
  p.activities.push({ ts: Date.now(), type: "error", detail });
  trimActivities(p);
  p.lastActivityAt = Date.now();
}

/**
 * Record a message event (assistant or user message in the conversation).
 * @param id Task/agent ID
 * @param detail Message summary
 */
export function recordMessage(id: string, detail: string): void {
  const p = activeProgress.get(id);
  if (!p) return;
  p.activities.push({ ts: Date.now(), type: "message", detail });
  trimActivities(p);
  p.lastActivityAt = Date.now();
}

// ============================================================================
// Helpers
// ============================================================================

/** Trim activities to MAX_ACTIVITY_ENTRIES, keeping the most recent */
function trimActivities(p: TaskProgress): void {
  if (p.activities.length > MAX_ACTIVITY_ENTRIES) {
    p.activities = p.activities.slice(-MAX_ACTIVITY_ENTRIES);
  }
}

// ============================================================================
// Summary Generation
// ============================================================================

/**
 * Generate a human-readable progress summary.
 * Used by TUI renderers, notifications, and status commands.
 */
export function generateProgressSummary(id: string): string {
  const p = activeProgress.get(id);
  if (!p) return "No progress data";

  const elapsed = Date.now() - p.startedAt;
  const elapsedSec = Math.round(elapsed / 1000);
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;
  const elapsedStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  const lines = [
    `📊 Progress for ${p.id}:`,
    `   Turns: ${p.turnCount} | Tools: ${p.toolUseCount} (${p.toolsUsed.join(", ") || "none"})`,
    `   Tokens: ${formatTokenUsage(p.tokenUsage)}`,
    `   Elapsed: ${elapsedStr}`,
    `   Last activity: ${new Date(p.lastActivityAt).toLocaleTimeString()}`,
  ];

  // Show last 5 activities
  const recent = p.activities.slice(-5);
  if (recent.length > 0) {
    lines.push("   Recent activity:");
    for (const a of recent) {
      const icon = { tool_use: "🔧", message: "💬", status_change: "🔄", error: "⚠️" }[a.type];
      lines.push(`     ${icon} ${a.detail}`);
    }
  }

  return lines.join("\n");
}

/**
 * Generate a compact one-line progress summary.
 * Used in parallel task displays and idle notifications.
 */
export function generateCompactSummary(id: string): string {
  const p = activeProgress.get(id);
  if (!p) return "(no progress)";
  const totalTokens = p.tokenUsage.input + p.tokenUsage.output;
  return `${p.turnCount} turns, ${p.toolUseCount} tools, ${formatTokenCount(totalTokens)} tokens`;
}

/**
 * Format token usage as a readable string.
 */
export function formatTokenUsage(usage: TokenUsage): string {
  const inK = formatTokenCount(usage.input);
  const outK = formatTokenCount(usage.output);
  const cacheK = formatTokenCount(usage.cacheRead);
  return `${inK} in / ${outK} out (${cacheK} cache)`;
}

/**
 * Format a raw token count as a human-readable string.
 * Under 1K: raw number. 1K-999K: XK format. 1M+: X.XM format.
 */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// ============================================================================
// Persistence
// ============================================================================

/**
 * Persist progress to disk for crash recovery.
 * Writes to the team's task directory if team info is available,
 * otherwise to the agent transcript directory.
 *
 * @param cwd Working directory
 * @param id Task/agent ID
 * @param team Optional team name (for task directory persistence)
 */
export function persistProgress(cwd: string, id: string, team?: string): void {
  const p = activeProgress.get(id);
  if (!p) return;

  const dir = team
    ? getTasksDir(cwd, team)
    : path.join(cwd, ".pi", "aim", "agents");

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}-${PROGRESS_FILE}`),
      JSON.stringify(p, null, 2),
    );
  } catch (err) {
    console.warn(`[aim] Failed to persist progress for ${id}:`, err);
  }
}

/**
 * Load progress from disk.
 * Returns null if no persisted progress exists.
 *
 * @param cwd Working directory
 * @param id Task/agent ID
 * @param team Optional team name
 */
export function loadProgress(cwd: string, id: string, team?: string): TaskProgress | null {
  const dir = team
    ? getTasksDir(cwd, team)
    : path.join(cwd, ".pi", "aim", "agents");

  try {
    const raw = fs.readFileSync(path.join(dir, `${id}-${PROGRESS_FILE}`), "utf-8");
    const p = JSON.parse(raw) as TaskProgress;
    // Re-register in the in-memory map
    activeProgress.set(id, p);
    return p;
  } catch {
    return null;
  }
}

/**
 * Delete persisted progress from disk.
 * Called during cleanup after task completion.
 *
 * @param cwd Working directory
 * @param id Task/agent ID
 * @param team Optional team name
 */
export function deletePersistedProgress(cwd: string, id: string, team?: string): void {
  const dir = team
    ? getTasksDir(cwd, team)
    : path.join(cwd, ".pi", "aim", "agents");

  try {
    fs.unlinkSync(path.join(dir, `${id}-${PROGRESS_FILE}`));
  } catch {
    // File may not exist — ignore
  }
}

// ============================================================================
// Usage Collection
// ============================================================================

/**
 * Collect usage statistics from a list of messages.
 * Shared utility to avoid duplication between index.ts and task-resume.ts.
 */
export function collectUsageFromMessages(messages: Message[]): {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cost: number; contextTokens: number; turns: number;
} {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, turns = 0;
  for (const msg of messages) {
    if (msg.role === "assistant") {
      turns++;
      const usage = (msg as Record<string, unknown>).usage as Record<string, number> | undefined;
      if (usage) {
        input += usage.input || 0;
        output += usage.output || 0;
        cacheRead += usage.cacheRead || 0;
        cacheWrite += usage.cacheWrite || 0;
      }
    }
  }
  return { input, output, cacheRead, cacheWrite, cost: 0, contextTokens: 0, turns };
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Clean up all progress trackers older than maxAgeMs.
 * Returns the number of trackers removed.
 *
 * @param maxAgeMs Maximum age in milliseconds (default: 1 hour)
 */
export function cleanupStaleProgress(maxAgeMs = 3_600_000): number {
  const now = Date.now();
  let removed = 0;
  for (const [id, p] of activeProgress) {
    if (now - p.lastActivityAt > maxAgeMs) {
      activeProgress.delete(id);
      removed++;
    }
  }
  return removed;
}

/**
 * Clear all progress trackers (for testing).
 */
export function clearAllProgress(): void {
  activeProgress.clear();
}
