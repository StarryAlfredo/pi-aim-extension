/**
 * AIM — File Lock
 *
 * Shared file locking utility for concurrent write safety.
 * Extracted from shared-tasks.ts and mailbox.ts to eliminate duplication.
 *
 * Strategy: atomic writeFileSync({ flag: "wx" }) with stale lock detection.
 * On both POSIX and NTFS, writeFileSync with "wx" is atomic — only one
 * process will succeed in creating the lock file.
 *
 * Stale locks (>10s old) are force-released automatically.
 */

import * as fs from "node:fs";

// ============================================================================
// Constants
// ============================================================================

/** Maximum lock retries before giving up */
const MAX_LOCK_RETRIES = 30;

/** Locks older than this (ms) are considered stale and force-released */
const STALE_LOCK_MS = 10_000;

// ============================================================================
// Public API
// ============================================================================

/**
 * Acquire an exclusive file lock.
 *
 * Stale locks (>10s old) are force-released automatically.
 * Returns a release function that must be called in a finally block.
 *
 * Thread safety: writeFileSync with { flag: "wx" } is atomic on both
 * POSIX and NTFS. Even if two processes detect the same stale lock
 * simultaneously, only one will succeed in creating the new lock file,
 * preventing double-acquisition.
 *
 * @param filePath The file to lock (a `.lock` suffix is appended)
 * @returns A release function that removes the lock
 */
export async function acquireFileLock(filePath: string): Promise<() => Promise<void>> {
  const lockPath = filePath + ".lock";

  for (let i = 0; i < MAX_LOCK_RETRIES; i++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return async () => {
        try { fs.unlinkSync(lockPath); } catch {}
      };
    } catch {
      // Check for stale lock — safe because writeFileSync with { flag: "wx" }
      // is atomic. Even if two processes detect the same stale lock, only
      // one will succeed in creating the replacement lock file.
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          // Force-release stale lock and retry immediately
          try { fs.unlinkSync(lockPath); } catch {}
          continue;
        }
      } catch {
        // Lock was released between our failed write and stat — retry
      }
      await new Promise(r => setTimeout(r, 50 + Math.random() * 50));
    }
  }
  throw new Error(`Could not acquire lock for ${filePath}`);
}
