/**
 * AIM — Worktree Manager
 *
 * Creates and cleans up Git worktrees for subagent isolation.
 * Each subagent gets its own worktree copy of the project, preventing
 * file conflicts with the parent agent and other concurrent subagents.
 *
 * Design follows Claude Code's worktree isolation pattern:
 *   - ENTER_WORKTREE before agent execution
 *   - EXIT_WORKTREE after agent completes
 *
 * Worktrees are placed in .pi/aim/worktrees/ to keep them out of the
 * main project tree and ensure they're cleaned up on session end.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Convert Windows backslash paths to forward-slash for git CLI */
function toGitPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Create a Git worktree for a subagent.
 * Returns { effectiveCwd, baseDir } where effectiveCwd is the worktree path
 * mirroring the parent's cwd, and baseDir is the worktree root (for cleanup).
 * Returns null on failure.
 */
export function createWorktree(cwd: string, agentId: string): { effectiveCwd: string; baseDir: string } | null {
  const worktreeName = `agent-${agentId}`;
  const worktreeDir = path.join(cwd, ".pi", "aim", "worktrees", worktreeName);
  const gitPath = toGitPath(worktreeDir);

  try {
    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });

    // Find repo root to compute the relative path inside the worktree
    const repoRoot = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
    const relativePath = path.relative(repoRoot, cwd); // e.g., "aim" or ""

    // Create worktree from current HEAD
    execSync(`git worktree add ${gitPath} HEAD`, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 10000,
    });

    // Return the cwd-equivalent path inside the worktree so the subagent
    // sees the same project structure as the parent
    return {
      effectiveCwd: relativePath ? path.join(worktreeDir, relativePath) : worktreeDir,
      baseDir: worktreeDir,
    };
  } catch (err) {
    // If worktree already exists (leftover from crash), force remove and retry once
    try {
      execSync(`git worktree remove --force ${gitPath}`, { cwd, stdio: "pipe" });
      try { fs.rmSync(worktreeDir, { recursive: true, force: true }); } catch {}
      execSync(`git worktree add ${gitPath} HEAD`, { cwd, encoding: "utf-8", stdio: "pipe" });
      const repoRoot2 = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
      const relativePath2 = path.relative(repoRoot2, cwd);
      return {
        effectiveCwd: relativePath2 ? path.join(worktreeDir, relativePath2) : worktreeDir,
        baseDir: worktreeDir,
      };
    } catch {
      return null; // Give up
    }
  }
}

/**
 * Remove a worktree given its base directory (NOT the effective cwd inside it).
 * We store worktreePath on the base dir for cleanup.
 */
export function removeWorktreeByBase(cwd: string, worktreeBaseDir: string): void {
  const gitPath = toGitPath(worktreeBaseDir);
  try {
    execSync(`git worktree remove --force ${gitPath}`, { cwd, stdio: "pipe" });
  } catch {}
  try {
    if (fs.existsSync(worktreeBaseDir)) {
      fs.rmSync(worktreeBaseDir, { recursive: true, force: true });
    }
  } catch {}
}

/**
 * Remove all stale worktrees from previous crashed sessions.
 * Called on extension startup.
 */
export function cleanupStaleWorktrees(cwd: string): void {
  const worktreesDir = path.join(cwd, ".pi", "aim", "worktrees");
  if (!fs.existsSync(worktreesDir)) return;

  let entries: string[];
  try {
    entries = fs.readdirSync(worktreesDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith("agent-")) {
      removeWorktreeByBase(cwd, path.join(worktreesDir, entry));
    }
  }
}