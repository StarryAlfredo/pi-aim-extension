/**
 * Worktree Isolation — Test Suite
 *
 * Tests Git worktree-based file system isolation for multi-agent execution.
 * When active, each subagent runs in its own worktree copy of the project,
 * preventing file conflicts and damage to the main working directory.
 *
 * Tests:
 *   1. Worktree created successfully (no LLM)
 *   2. Worktree contains project files (no LLM)
 *   3. Worktree modifications are ISOLATED from main dir (no LLM)
 *   4. Worktree cleaned up after use (no LLM)
 *   5. Subagent runs inside worktree, produces output in isolation (LLM)
 *   6. Two concurrent worktrees — independent, no cross-contamination (LLM)
 *
 * Run: npx tsx test/test-worktree.ts
 * Or:  pi -e ../aim/index.ts -p @test-worktree.ts
 */

import { spawnSync, execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// ============================================================================
// Helpers
// ============================================================================

let testCount = 0;
let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function assert(condition: boolean, test: string, detail: string) {
  if (condition) { passCount++; }
  else { failCount++; failures.push(`${test}: ${detail}`); }
  testCount++;
}

function log(phase: string, msg: string) {
  console.log(`  [${phase}] ${msg}`);
}

/** Convert Windows backslash paths to forward-slash for git CLI compatibility */
function toGitPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Clean up a worktree and its temp directory */
function cleanupWorktree(worktreePath: string) {
  const gitPath = toGitPath(worktreePath);
  try {
    execSync(`git worktree remove --force ${gitPath}`, {
      cwd: process.cwd(),
      stdio: "pipe",
    });
  } catch { /* may already be removed */ }
  try {
    if (fs.existsSync(worktreePath)) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  } catch { /* best-effort cleanup */ }
}

/** Spawn pi in RPC mode with a specific cwd */
function spawnRpcWorker(cwd: string, model?: string): {
  proc: ReturnType<typeof spawn>;
  send(obj: Record<string, unknown>): void;
  waitForEvent(eventType: string, timeoutMs?: number): Promise<Record<string, unknown> | null>;
  stop(): void;
} {
  const args: string[] = ["--mode", "rpc", "--no-session", "--tools", "bash,write,read", "--model", model ?? "zai/glm-5.1"];
  const piCmd = process.platform === "win32"
    ? ["cmd", "/c", "pi.cmd"]
    : ["pi"];
  const proc = spawn(piCmd[0], [...piCmd.slice(1), ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending: Array<{ eventType: string; resolve: (v: Record<string, unknown> | null) => void; deadline: number }> = [];
  let stopped = false;

  proc.stdout?.on("data", (data: Buffer) => {
    if (stopped) return;
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        for (let i = pending.length - 1; i >= 0; i--) {
          if (pending[i].eventType === e.type) {
            pending.splice(i, 1)[0].resolve(e);
            return;
          }
        }
      } catch { /* skip non-JSON */ }
    }
  });

  proc.stderr?.on("data", () => {});

  return {
    proc,
    send(obj: Record<string, unknown>) {
      if (!proc.stdin?.destroyed) proc.stdin.write(JSON.stringify(obj) + "\n");
    },
    waitForEvent(eventType: string, timeoutMs = 30000): Promise<Record<string, unknown> | null> {
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolve) => {
        const entry = { eventType, resolve, deadline };
        pending.push(entry);
        const interval = setInterval(() => {
          if (stopped) { clearInterval(interval); resolve(null); return; }
          if (pending.indexOf(entry) === -1) { clearInterval(interval); return; }
          if (Date.now() > deadline) {
            pending.splice(pending.indexOf(entry), 1);
            clearInterval(interval);
            resolve(null);
          }
        }, 200);
      });
    },
    stop() { stopped = true; },
  };
}

// ============================================================================
// Test Cases
// ============================================================================

async function test1_worktreeCreated(cwd: string) {
  console.log("\n=== Test 1: Worktree created successfully ===");
  const worktreeName = "test-worktree-" + Date.now().toString(36);
  const worktreeDir = path.join(cwd, ".pi", "aim", worktreeName);

  try {
    // Use forward-slash path for git CLI compatibility on Windows
    const gitPath = toGitPath(worktreeDir);
    const result = execSync(
      `git worktree add ${gitPath} HEAD`,
      { cwd, encoding: "utf-8", stdio: "pipe" }
    );
    log("git", `git worktree add → ${result.trim().slice(0, 120)}`);

    // Assertions
    assert(fs.existsSync(worktreeDir), "worktree directory exists", worktreeDir);
    assert(
      fs.existsSync(path.join(worktreeDir, ".git")),
      "worktree has .git file (linked to main repo)",
      ""
    );

    // Verify it's a real worktree (git worktree list should include it)
    const list = execSync("git worktree list", { cwd, encoding: "utf-8" });
    assert(list.includes(worktreeName), "git worktree list includes new worktree", list.trim());
  } finally {
    cleanupWorktree(worktreeDir);
  }
}

async function test2_worktreeHasProjectFiles(cwd: string) {
  console.log("\n=== Test 2: Worktree contains project files ===");
  const worktreeName = "test-worktree-" + Date.now().toString(36);
  const worktreeDir = path.join(cwd, ".pi", "aim", worktreeName);

  try {
    execSync(`git worktree add ${toGitPath(worktreeDir)} HEAD`, { cwd, stdio: "pipe" });

    // git ls-files returns paths relative to repo root. Worktree is a checkout
    // of the repo root, so files are at worktreeDir/<repoRelativePath>.
    // Find repo root to compute the subpath offset from repo root to cwd.
    const repoRoot = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8" }).trim();
    const cwdRelative = path.relative(repoRoot, cwd); // e.g. "aim" if cwd is repoRoot/aim

    const trackedOutput = execSync("git ls-files --full-name", { cwd, encoding: "utf-8" });
    const trackedFiles = trackedOutput.trim().split("\n")
      .filter(f => f.length > 0 && f.startsWith(cwdRelative + "/"))
      .map(f => f.slice(cwdRelative.length + 1)) // strip the cwd prefix, get filename only
      .slice(0, 10);
    log("check", `sampling ${trackedFiles.length} git-tracked files: ${trackedFiles.join(", ")}`);

    // Assert: same files exist in worktree (worktree mirrors repo root,
    // so file "index.ts" in cwd is at worktreeDir/cwdRelative/index.ts)
    let matchCount = 0;
    for (const f of trackedFiles) {
      if (fs.existsSync(path.join(worktreeDir, cwdRelative, f))) matchCount++;
    }
    assert(matchCount === trackedFiles.length, "all sampled git-tracked files exist in worktree", `${matchCount}/${trackedFiles.length} matched`);
  } finally {
    cleanupWorktree(worktreeDir);
  }
}

async function test3_worktreeModificationsAreIsolated(cwd: string) {
  console.log("\n=== Test 3: Worktree modifications are ISOLATED from main dir ===");
  const worktreeName = "test-worktree-" + Date.now().toString(36);
  const worktreeDir = path.join(cwd, ".pi", "aim", worktreeName);
  const testFileName = "test-isolation-" + randomUUID().slice(0, 8) + ".txt";
  const testContent = "created-by-worktree-test-" + Date.now();

  try {
    execSync(`git worktree add ${toGitPath(worktreeDir)} HEAD`, { cwd, stdio: "pipe" });

    // Create a file INSIDE the worktree
    const worktreeFilePath = path.join(worktreeDir, testFileName);
    fs.writeFileSync(worktreeFilePath, testContent, "utf-8");
    log("write", `wrote to worktree: ${worktreeFilePath}`);

    // Assert: file exists in worktree
    assert(fs.existsSync(worktreeFilePath), "file exists in worktree", worktreeFilePath);

    // Assert: file does NOT exist in main dir
    const mainFilePath = path.join(cwd, testFileName);
    assert(!fs.existsSync(mainFilePath), "file NOT in main directory", `${mainFilePath} should not exist`);

    // Assert: modify existing file in worktree, main dir unchanged
    const packageJsonPath = "package.json";
    if (fs.existsSync(path.join(cwd, packageJsonPath))) {
      const originalContent = fs.readFileSync(path.join(cwd, packageJsonPath), "utf-8");
      const worktreePkgPath = path.join(worktreeDir, packageJsonPath);
      fs.writeFileSync(worktreePkgPath, originalContent + "\n/* worktree modification marker */", "utf-8");
      const mainAfterContent = fs.readFileSync(path.join(cwd, packageJsonPath), "utf-8");
      assert(
        mainAfterContent === originalContent,
        "main package.json unchanged after worktree modification",
        "main dir was not affected"
      );
      // Restore
      fs.writeFileSync(worktreePkgPath, originalContent, "utf-8");
    } else {
      log("skip", "no package.json in project root, skipping modify-existing test");
    }
  } finally {
    cleanupWorktree(worktreeDir);
    // Clean up test file from main dir just in case
    const mainFilePath = path.join(cwd, testFileName);
    try { if (fs.existsSync(mainFilePath)) fs.unlinkSync(mainFilePath); } catch {}
  }
}

async function test4_worktreeCleanup(cwd: string) {
  console.log("\n=== Test 4: Worktree cleaned up after use ===");
  const worktreeName = "test-worktree-" + Date.now().toString(36);
  const worktreeDir = path.join(cwd, ".pi", "aim", worktreeName);

  try {
    execSync(`git worktree add ${toGitPath(worktreeDir)} HEAD`, { cwd, stdio: "pipe" });
    assert(fs.existsSync(worktreeDir), "worktree exists before cleanup", "");

    // Clean it up
    cleanupWorktree(worktreeDir);

    // Assert: directory is gone
    assert(!fs.existsSync(worktreeDir), "worktree directory removed", worktreeDir);

    // Assert: git worktree list no longer includes it
    const list = execSync("git worktree list", { cwd, encoding: "utf-8" });
    assert(!list.includes(worktreeName), "git worktree list no longer includes removed worktree", list.trim());
  } finally {
    // Ensure cleanup even if assertions fail
    cleanupWorktree(worktreeDir);
  }
}

async function test5_subagentRunsInWorktree(cwd: string) {
  console.log("\n=== Test 5: Subagent runs inside worktree, output isolated ===");
  const worktreeName = "test-worktree-" + Date.now().toString(36);
  const worktreeDir = path.join(cwd, ".pi", "aim", worktreeName);
  const testFileName = "test-worktree-output-" + randomUUID().slice(0, 8) + ".txt";

  try {
    execSync(`git worktree add ${toGitPath(worktreeDir)} HEAD`, { cwd, stdio: "pipe" });

    const worker = spawnRpcWorker(worktreeDir);
    const { proc, send, waitForEvent } = worker;

    try {
      // Send prompt: create a specific file
      send({
        type: "prompt",
        message: `use write tool to create file "${testFileName}" with content "hello from worktree isolation test". Only create the file, do nothing else.`,
      });

      const agentEnd = await waitForEvent("agent_end", 60000);
      assert(agentEnd !== null, "worker completed in worktree", "agent_end received");

      // Assert: file exists in worktree
      const worktreeFilePath = path.join(worktreeDir, testFileName);
      const existsInWorktree = fs.existsSync(worktreeFilePath);
      assert(existsInWorktree, "file created in worktree", worktreeFilePath);

      if (existsInWorktree) {
        const content = fs.readFileSync(worktreeFilePath, "utf-8");
        assert(
          content.includes("hello from worktree"),
          "worktree file has correct content",
          `content: "${content}"`
        );
      }

      // Assert: file does NOT exist in main dir
      const mainFilePath = path.join(cwd, testFileName);
      assert(!fs.existsSync(mainFilePath), "file NOT in main directory", "isolation verified");
    } finally {
      proc.kill();
    }
  } finally {
    cleanupWorktree(worktreeDir);
    // Clean up main dir just in case
    const mainFilePath = path.join(cwd, testFileName);
    try { if (fs.existsSync(mainFilePath)) fs.unlinkSync(mainFilePath); } catch {}
  }
}

async function test6_concurrentWorktrees(cwd: string) {
  console.log("\n=== Test 6: Two concurrent worktrees — independent ===");

  const wtName1 = "test-wt-1-" + Date.now().toString(36);
  const wtName2 = "test-wt-2-" + Date.now().toString(36);
  const wtDir1 = path.join(cwd, ".pi", "aim", wtName1);
  const wtDir2 = path.join(cwd, ".pi", "aim", wtName2);
  const file1 = "wt-1-output-" + randomUUID().slice(0, 8) + ".txt";
  const file2 = "wt-2-output-" + randomUUID().slice(0, 8) + ".txt";

  try {
    // Create both worktrees
    execSync(`git worktree add ${toGitPath(wtDir1)} HEAD`, { cwd, stdio: "pipe" });
    execSync(`git worktree add ${toGitPath(wtDir2)} HEAD`, { cwd, stdio: "pipe" });

    // Spawn two workers concurrently
    const w1 = spawnRpcWorker(wtDir1);
    const w2 = spawnRpcWorker(wtDir2);

    try {
      // Send both prompts
      w1.send({ type: "prompt", message: `use write tool to create file "${file1}" with content "worktree-one-output". Only create the file.` });
      w2.send({ type: "prompt", message: `use write tool to create file "${file2}" with content "worktree-two-output". Only create the file.` });

      // Wait for both to complete (concurrently)
      const [end1, end2] = await Promise.all([
        w1.waitForEvent("agent_end", 60000),
        w2.waitForEvent("agent_end", 60000),
      ]);

      assert(end1 !== null, "worker 1 completed", "agent_end for wt1");
      assert(end2 !== null, "worker 2 completed", "agent_end for wt2");

      // Check worktree 1
      const fp1 = path.join(wtDir1, file1);
      assert(fs.existsSync(fp1), "file1 exists in worktree 1", fp1);
      if (fs.existsSync(fp1)) {
        const c1 = fs.readFileSync(fp1, "utf-8");
        assert(c1.includes("worktree-one"), "worker1 content correct", c1);
      }

      // Check worktree 2
      const fp2 = path.join(wtDir2, file2);
      assert(fs.existsSync(fp2), "file2 exists in worktree 2", fp2);
      if (fs.existsSync(fp2)) {
        const c2 = fs.readFileSync(fp2, "utf-8");
        assert(c2.includes("worktree-two"), "worker2 content correct", c2);
      }

      // Assert: cross-contamination — file1 NOT in wt2, file2 NOT in wt1
      assert(!fs.existsSync(path.join(wtDir1, file2)), "worker2 file NOT in worktree 1", "no cross-contamination");
      assert(!fs.existsSync(path.join(wtDir2, file1)), "worker1 file NOT in worktree 2", "no cross-contamination");

      // Assert: neither file in main dir
      assert(!fs.existsSync(path.join(cwd, file1)), "worker1 file NOT in main dir", "");
      assert(!fs.existsSync(path.join(cwd, file2)), "worker2 file NOT in main dir", "");
    } finally {
      w1.proc.kill();
      w2.proc.kill();
    }
  } finally {
    cleanupWorktree(wtDir1);
    cleanupWorktree(wtDir2);
    try { if (fs.existsSync(path.join(cwd, file1))) fs.unlinkSync(path.join(cwd, file1)); } catch {}
    try { if (fs.existsSync(path.join(cwd, file2))) fs.unlinkSync(path.join(cwd, file2)); } catch {}
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const cwd = process.cwd();
  console.log("AIM Worktree Isolation — Test Suite");
  console.log(`CWD: ${cwd}`);
  console.log("===========================================");

  const startTime = Date.now();

  // No-LLM tests first (fast, verify infrastructure)
  await test1_worktreeCreated(cwd);
  await test2_worktreeHasProjectFiles(cwd);
  await test3_worktreeModificationsAreIsolated(cwd);
  await test4_worktreeCleanup(cwd);

  // LLM tests (require model access)
  await test5_subagentRunsInWorktree(cwd);
  await test6_concurrentWorktrees(cwd);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n===========================================");
  console.log(`Results: ${passCount}/${testCount} passed, ${failCount} failed (${elapsed}s)`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  } else {
    console.log("All tests passed!");
    process.exit(0);
  }
}

main().catch(err => {
  console.error("Test suite crashed:", err);
  process.exit(2);
});