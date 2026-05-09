/**
 * AIM — Task Result Storage (P7)
 *
 * Centralized result overflow protection for all subagent execution modes.
 * When a subagent's output exceeds the inline limit, it is automatically
 * persisted to disk and replaced with a preview + file reference.
 *
 * Design mirrors Claude Code's toolResultStorage:
 *   - Per-agent inline limit: 50,000 chars (tool-level threshold)
 *   - Per-agent preview: 2,000 chars (kept inline after persistence)
 *   - Per-message budget: 200,000 chars (sum of ALL inline results in one turn)
 *   - Oversized results saved to .pi/aim/task-outputs/{agentId}-output.txt
 *   - Parent agent uses the read tool to access full output
 *
 * Integration points:
 *   - index.ts: calls handleResultOverflow() on every SingleResult
 *   - task-output-tool.ts: calls readPersistedResult() for completed tasks
 *   - render.ts: calls isResultPersisted() to show file reference in TUI
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Constants
// ============================================================================

/** Maximum chars to keep inline per agent result. Beyond this → disk. */
export const PER_AGENT_INLINE_LIMIT = 50_000;

/** Preview chars kept inline after persisting to disk. */
export const PER_AGENT_PREVIEW_BYTES = 2_000;

/** Maximum total inline chars across ALL results in a single tool response.
 *  When exceeded, all results get file-path-only summaries. */
export const PER_MESSAGE_BUDGET = 200_000;

/** Directory for persisted result files */
const RESULT_OUTPUTS_DIR = "task-outputs";

/** Maximum age (ms) for result files before auto-cleanup. Default: 24 hours. */
const DEFAULT_MAX_AGE_MS = 86_400_000;

// ============================================================================
// Types
// ============================================================================

/** Result of overflow handling for a single agent */
export interface OverflowResult {
  /** The display text (preview + file reference, or full inline text) */
  display: string;
  /** Original full output length */
  fullLength: number;
  /** Whether the result was persisted to disk */
  persisted: boolean;
  /** Path to the persisted file (if persisted) */
  filePath?: string;
  /** Whether this result was truncated for the per-message budget */
  budgetTruncated: boolean;
}

/** Result of batch overflow handling (for parallel mode) */
export interface BatchOverflowResult {
  /** Per-agent overflow results */
  items: OverflowResult[];
  /** Total inline size across all items */
  totalInlineSize: number;
  /** Whether the per-message budget was exceeded */
  overBudget: boolean;
}

/** Metadata for a persisted result file */
export interface ResultFileMeta {
  agentId: string;
  taskId?: string;
  createdAt: number;
  sizeBytes: number;
}

// ============================================================================
// Path Helpers
// ============================================================================

/** Get the result outputs directory for a project */
export function getResultOutputsDir(cwd: string): string {
  return path.join(cwd, ".pi", "aim", RESULT_OUTPUTS_DIR);
}

/** Get the file path for a specific agent's output */
export function getResultFilePath(cwd: string, agentId: string): string {
  return path.join(getResultOutputsDir(cwd), `${agentId}-output.txt`);
}

/** Ensure the result outputs directory exists */
function ensureResultDir(cwd: string): void {
  const dir = getResultOutputsDir(cwd);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
  }
}

// ============================================================================
// Core: Single Result Overflow
// ============================================================================

/**
 * Handle overflow for a single agent result.
 *
 * If the output exceeds PER_AGENT_INLINE_LIMIT:
 *   1. Persist the full output to disk
 *   2. Return a preview + file path reference
 *
 * If the output is within limits:
 *   1. Return the full output inline
 *
 * @param cwd Working directory
 * @param agentId Agent ID (used for file naming)
 * @param fullOutput The complete output text
 * @param options Optional overrides for thresholds
 */
export function handleResultOverflow(
  cwd: string,
  agentId: string,
  fullOutput: string,
  options?: {
    inlineLimit?: number;
    previewBytes?: number;
  },
): OverflowResult {
  const inlineLimit = options?.inlineLimit ?? PER_AGENT_INLINE_LIMIT;
  const previewBytes = options?.previewBytes ?? PER_AGENT_PREVIEW_BYTES;

  // Small result: full inline
  if (fullOutput.length <= inlineLimit) {
    return {
      display: fullOutput,
      fullLength: fullOutput.length,
      persisted: false,
      budgetTruncated: false,
    };
  }

  // Large result: persist to disk, return preview + reference
  ensureResultDir(cwd);
  const filePath = getResultFilePath(cwd, agentId);
  fs.writeFileSync(filePath, fullOutput, "utf-8");

  const preview = fullOutput.slice(0, previewBytes);
  const relPath = `.pi/aim/${RESULT_OUTPUTS_DIR}/${agentId}-output.txt`;

  return {
    display: [
      preview,
      ``,
      `... (truncated, ${fullOutput.length.toLocaleString()} chars total)`,
      `Full output: ${relPath}`,
      `Use the read tool to access the full output.`,
    ].join("\n"),
    fullLength: fullOutput.length,
    persisted: true,
    filePath: relPath,
    budgetTruncated: false,
  };
}

// ============================================================================
// Core: Batch Overflow (Parallel Mode)
// ============================================================================

/**
 * Handle overflow for a batch of agent results (parallel mode).
 *
 * Phase 1: Persist any individual results exceeding PER_AGENT_INLINE_LIMIT
 * Phase 2: Apply per-message budget — if total inline exceeds budget,
 *          truncate all items to preview-only mode
 *
 * @param cwd Working directory
 * @param items Array of { agentId, fullOutput } pairs
 * @param options Optional overrides
 */
export function handleBatchOverflow(
  cwd: string,
  items: Array<{ agentId: string; fullOutput: string; agentName: string; exitCode: number }>,
  options?: {
    inlineLimit?: number;
    previewBytes?: number;
    messageBudget?: number;
  },
): BatchOverflowResult {
  const messageBudget = options?.messageBudget ?? PER_MESSAGE_BUDGET;

  // Phase 1: Per-agent overflow handling
  const overflowItems: OverflowResult[] = items.map(item => {
    return handleResultOverflow(cwd, item.agentId, item.fullOutput, options);
  });

  // Phase 2: Per-message budget check
  let totalInlineSize = overflowItems.reduce((sum, item) => sum + item.display.length, 0);
  let overBudget = totalInlineSize > messageBudget;

  if (overBudget) {
    // Budget exceeded: truncate all items to preview-only mode
    const previewBytes = options?.previewBytes ?? PER_AGENT_PREVIEW_BYTES;

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const overflow = overflowItems[i]!;

      // If not already persisted, persist now
      if (!overflow.persisted && item.fullOutput.length > 0) {
        ensureResultDir(cwd);
        const filePath = getResultFilePath(cwd, item.agentId);
        fs.writeFileSync(filePath, item.fullOutput, "utf-8");
        overflow.persisted = true;
        overflow.filePath = `.pi/aim/${RESULT_OUTPUTS_DIR}/${item.agentId}-output.txt`;
      }

      // Truncate display to preview
      const preview = item.fullOutput.slice(0, previewBytes);
      overflow.display = [
        preview,
        ``,
        `... (${item.fullOutput.length.toLocaleString()} chars total)`,
        overflow.filePath ? `Full output: ${overflow.filePath}` : "",
      ].filter(Boolean).join("\n");
      overflow.budgetTruncated = true;
    }

    // Recalculate total size after truncation
    totalInlineSize = overflowItems.reduce((sum, item) => sum + item.display.length, 0);
  }

  return { items: overflowItems, totalInlineSize, overBudget };
}

// ============================================================================
// Reading Persisted Results
// ============================================================================

/**
 * Read a persisted result file from disk.
 * Returns null if the file doesn't exist.
 *
 * Used by task-output-tool to retrieve full output for completed tasks.
 */
export function readPersistedResult(cwd: string, agentId: string): string | null {
  const filePath = getResultFilePath(cwd, agentId);
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Check if a result has been persisted to disk.
 */
export function isResultPersisted(cwd: string, agentId: string): boolean {
  const filePath = getResultFilePath(cwd, agentId);
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the file path for a persisted result, or null if not persisted.
 */
export function getPersistedResultPath(cwd: string, agentId: string): string | null {
  if (isResultPersisted(cwd, agentId)) {
    return `.pi/aim/${RESULT_OUTPUTS_DIR}/${agentId}-output.txt`;
  }
  return null;
}

// ============================================================================
// Result File Lifecycle
// ============================================================================

/**
 * List all persisted result files with metadata.
 */
export function listResultFiles(cwd: string): ResultFileMeta[] {
  const dir = getResultOutputsDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const results: ResultFileMeta[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith("-output.txt")) continue;
      try {
        const filePath = path.join(dir, f);
        const stat = fs.statSync(filePath);
        const agentId = f.replace("-output.txt", "");
        results.push({
          agentId,
          createdAt: stat.birthtimeMs,
          sizeBytes: stat.size,
        });
      } catch {}
    }
  } catch {}

  return results.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Clean up result files older than maxAgeMs.
 * Returns the number of files removed.
 *
 * @param maxAgeMs Maximum age in milliseconds (default: 24 hours)
 */
export function cleanupResultFiles(cwd: string, maxAgeMs = DEFAULT_MAX_AGE_MS): number {
  const now = Date.now();
  const files = listResultFiles(cwd);
  let removed = 0;

  for (const meta of files) {
    if (now - meta.createdAt > maxAgeMs) {
      try {
        fs.unlinkSync(getResultFilePath(cwd, meta.agentId));
        removed++;
      } catch {}
    }
  }

  return removed;
}

/**
 * Delete a specific result file.
 */
export function deleteResultFile(cwd: string, agentId: string): boolean {
  const filePath = getResultFilePath(cwd, agentId);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Format Helpers
// ============================================================================

/**
 * Format an overflow result for display in a tool response.
 * Includes status icon, agent name, and error hint for failures.
 */
export function formatOverflowDisplay(
  overflow: OverflowResult,
  agentName: string,
  exitCode: number,
): string {
  const statusIcon = exitCode === 0 ? "✓" : "✗";
  const errorHint = exitCode !== 0
    ? "\n⚠️ This agent FAILED. Retry with corrected parameters."
    : "";
  return `[${agentName}] ${statusIcon}: ${overflow.display}${errorHint}`;
}

/**
 * Format a batch overflow result for display in a parallel tool response.
 * Includes summary stats, truncation notes, and per-agent results.
 */
export function formatBatchOverflowDisplay(
  batch: BatchOverflowResult,
  agentNames: string[],
  exitCodes: number[],
  successCount: number,
  totalCount: number,
): string {
  const lines: string[] = [];

  // Summary line
  lines.push(`Parallel: ${successCount}/${totalCount} OK`);

  // Truncation notes
  const hasPersisted = batch.items.some(i => i.persisted);
  const hasBudgetTruncation = batch.overBudget;

  if (hasPersisted) {
    lines.push(`⚠️ Some results truncated. Read the output file shown for full content.`);
  }
  if (hasBudgetTruncation) {
    lines.push(
      `⚠️ Per-message budget (${PER_MESSAGE_BUDGET.toLocaleString()} chars) exceeded ` +
      `(${batch.totalInlineSize.toLocaleString()} chars total). ` +
      `Read individual output files for full results.`,
    );
  }

  lines.push("");

  // Per-agent results
  for (let i = 0; i < batch.items.length; i++) {
    const item = batch.items[i]!;
    const name = agentNames[i] ?? "unknown";
    const code = exitCodes[i] ?? 1;
    lines.push(formatOverflowDisplay(item, name, code));
    if (i < batch.items.length - 1) lines.push("");
  }

  return lines.join("\n");
}
