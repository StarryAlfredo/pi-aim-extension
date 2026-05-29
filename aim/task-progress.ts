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
import { getTasksDir } from "./types.ts";
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
// ProgressTracker Class
// ============================================================================

/**
 * Manages progress tracking for tasks and agents.
 * Encapsulates the in-memory registry and provides methods for
 * creating, querying, recording, and persisting progress data.
 */
export class ProgressTracker {
  private activeProgress = new Map<string, TaskProgress>();

  /**
   * Create a new progress tracker for a task/agent.
   * Returns the initialized progress object.
   */
  create(id: string): TaskProgress {
    // If overwriting an existing tracker, remove it first to prevent stale data.
    // This can happen during resume or agent restart scenarios.
    if (this.activeProgress.has(id)) {
      console.warn(`[aim] Overwriting existing progress tracker for ${id}`);
      this.activeProgress.delete(id);
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
    this.activeProgress.set(id, progress);
    return progress;
  }

  /**
   * Remove a progress tracker from the in-memory registry.
   * Call after the task completes and progress has been persisted.
   */
  remove(id: string): void {
    this.activeProgress.delete(id);
  }

  /**
   * Get an existing progress tracker, or null if not tracked.
   */
  get(id: string): TaskProgress | null {
    return this.activeProgress.get(id) ?? null;
  }

  /**
   * Get all active progress trackers.
   */
  getAll(): TaskProgress[] {
    return Array.from(this.activeProgress.values());
  }

  /**
   * Record a tool use event.
   * @param id Task/agent ID
   * @param toolName Name of the tool invoked
   */
  recordToolUse(id: string, toolName: string): void {
    const p = this.activeProgress.get(id);
    if (!p) return;
    p.toolUseCount++;
    if (!p.toolsUsed.includes(toolName)) {
      p.toolsUsed.push(toolName);
    }
    p.activities.push({ ts: Date.now(), type: "tool_use", detail: toolName });
    this.trimActivities(p);
    p.lastActivityAt = Date.now();
  }

  /**
   * Record token usage from an API response.
   * Increments the running totals.
   * @param id Task/agent ID
   * @param usage Partial token usage to add
   */
  recordTokenUsage(id: string, usage: Partial<TokenUsage>): void {
    const p = this.activeProgress.get(id);
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
  recordTurn(id: string): void {
    const p = this.activeProgress.get(id);
    if (!p) return;
    p.turnCount++;
    p.lastActivityAt = Date.now();
  }

  /**
   * Record a status change event.
   * @param id Task/agent ID
   * @param detail Human-readable status description
   */
  recordStatusChange(id: string, detail: string): void {
    const p = this.activeProgress.get(id);
    if (!p) return;
    p.activities.push({ ts: Date.now(), type: "status_change", detail });
    this.trimActivities(p);
    p.lastActivityAt = Date.now();
  }

  /**
   * Record an error event.
   * @param id Task/agent ID
   * @param detail Error description
   */
  recordError(id: string, detail: string): void {
    const p = this.activeProgress.get(id);
    if (!p) return;
    p.activities.push({ ts: Date.now(), type: "error", detail });
    this.trimActivities(p);
    p.lastActivityAt = Date.now();
  }

  /**
   * Record a message event (assistant or user message in the conversation).
   * @param id Task/agent ID
   * @param detail Message summary
   */
  recordMessage(id: string, detail: string): void {
    const p = this.activeProgress.get(id);
    if (!p) return;
    p.activities.push({ ts: Date.now(), type: "message", detail });
    this.trimActivities(p);
    p.lastActivityAt = Date.now();
  }

  /**
   * Generate a human-readable progress summary.
   * Used by TUI renderers, notifications, and status commands.
   */
  generateSummary(id: string): string {
    const p = this.activeProgress.get(id);
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
  generateCompactSummary(id: string): string {
    const p = this.activeProgress.get(id);
    if (!p) return "(no progress)";
    const totalTokens = p.tokenUsage.input + p.tokenUsage.output;
    return `${p.turnCount} turns, ${p.toolUseCount} tools, ${formatTokenCount(totalTokens)} tokens`;
  }

  /**
   * Persist progress to disk for crash recovery.
   * Writes to the team's task directory if team info is available,
   * otherwise to the agent transcript directory.
   *
   * @param cwd Working directory
   * @param id Task/agent ID
   * @param team Optional team name (for task directory persistence)
   */
  persist(cwd: string, id: string, team?: string): void {
    const p = this.activeProgress.get(id);
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
  load(cwd: string, id: string, team?: string): TaskProgress | null {
    const dir = team
      ? getTasksDir(cwd, team)
      : path.join(cwd, ".pi", "aim", "agents");

    try {
      const raw = fs.readFileSync(path.join(dir, `${id}-${PROGRESS_FILE}`), "utf-8");
      const p = JSON.parse(raw) as TaskProgress;
      // Re-register in the in-memory map
      this.activeProgress.set(id, p);
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
  deletePersisted(cwd: string, id: string, team?: string): void {
    const dir = team
      ? getTasksDir(cwd, team)
      : path.join(cwd, ".pi", "aim", "agents");

    try {
      fs.unlinkSync(path.join(dir, `${id}-${PROGRESS_FILE}`));
    } catch {
      // File may not exist — ignore
    }
  }

  /**
   * Clean up all progress trackers older than maxAgeMs.
   * Returns the number of trackers removed.
   *
   * @param maxAgeMs Maximum age in milliseconds (default: 1 hour)
   */
  cleanupStale(maxAgeMs = 3_600_000): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, p] of this.activeProgress) {
      if (now - p.lastActivityAt > maxAgeMs) {
        this.activeProgress.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Clear all progress trackers (for testing).
   */
  clearAll(): void {
    this.activeProgress.clear();
  }

  /** Trim activities to MAX_ACTIVITY_ENTRIES, keeping the most recent */
  private trimActivities(p: TaskProgress): void {
    if (p.activities.length > MAX_ACTIVITY_ENTRIES) {
      p.activities = p.activities.slice(-MAX_ACTIVITY_ENTRIES);
    }
  }
}

// ============================================================================
// Singleton Instance & Backward-Compatible Functional API
// ============================================================================

/** Singleton instance for module-level access */
export const progressTracker = new ProgressTracker();

/**
 * Create a new progress tracker for a task/agent.
 * Returns the initialized progress object.
 * @deprecated Use progressTracker.create() instead
 */
export const createProgressTracker = progressTracker.create.bind(progressTracker);

/**
 * Remove a progress tracker from the in-memory registry.
 * @deprecated Use progressTracker.remove() instead
 */
export const removeProgressTracker = progressTracker.remove.bind(progressTracker);

/**
 * Get an existing progress tracker, or null if not tracked.
 * @deprecated Use progressTracker.get() instead
 */
export const getProgressTracker = progressTracker.get.bind(progressTracker);

/**
 * Get all active progress trackers.
 * @deprecated Use progressTracker.getAll() instead
 */
export const getAllProgressTrackers = progressTracker.getAll.bind(progressTracker);

/**
 * Record a tool use event.
 * @deprecated Use progressTracker.recordToolUse() instead
 */
export const recordToolUse = progressTracker.recordToolUse.bind(progressTracker);

/**
 * Record token usage from an API response.
 * @deprecated Use progressTracker.recordTokenUsage() instead
 */
export const recordTokenUsage = progressTracker.recordTokenUsage.bind(progressTracker);

/**
 * Record a turn completion.
 * @deprecated Use progressTracker.recordTurn() instead
 */
export const recordTurn = progressTracker.recordTurn.bind(progressTracker);

/**
 * Record a status change event.
 * @deprecated Use progressTracker.recordStatusChange() instead
 */
export const recordStatusChange = progressTracker.recordStatusChange.bind(progressTracker);

/**
 * Record an error event.
 * @deprecated Use progressTracker.recordError() instead
 */
export const recordError = progressTracker.recordError.bind(progressTracker);

/**
 * Record a message event.
 * @deprecated Use progressTracker.recordMessage() instead
 */
export const recordMessage = progressTracker.recordMessage.bind(progressTracker);

/**
 * Generate a human-readable progress summary.
 * @deprecated Use progressTracker.generateSummary() instead
 */
export const generateProgressSummary = progressTracker.generateSummary.bind(progressTracker);

/**
 * Generate a compact one-line progress summary.
 * @deprecated Use progressTracker.generateCompactSummary() instead
 */
export const generateCompactSummary = progressTracker.generateCompactSummary.bind(progressTracker);

/**
 * Persist progress to disk.
 * @deprecated Use progressTracker.persist() instead
 */
export const persistProgress = progressTracker.persist.bind(progressTracker);

/**
 * Load progress from disk.
 * @deprecated Use progressTracker.load() instead
 */
export const loadProgress = progressTracker.load.bind(progressTracker);

/**
 * Delete persisted progress from disk.
 * @deprecated Use progressTracker.deletePersisted() instead
 */
export const deletePersistedProgress = progressTracker.deletePersisted.bind(progressTracker);

/**
 * Clean up stale progress trackers.
 * @deprecated Use progressTracker.cleanupStale() instead
 */
export const cleanupStaleProgress = progressTracker.cleanupStale.bind(progressTracker);

/**
 * Clear all progress trackers.
 * @deprecated Use progressTracker.clearAll() instead
 */
export const clearAllProgress = progressTracker.clearAll.bind(progressTracker);

// ============================================================================
// Utility Functions (not part of the class — stateless)
// ============================================================================

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
