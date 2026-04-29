/**
 * AIM — Mailbox
 *
 * File-based inbox system for inter-agent communication.
 * Each agent has an inbox file at `.pi/aim/teams/{team}/inboxes/{agent}.json`.
 *
 * Features:
 * - JSON array of messages with read/unread tracking
 * - File locking (via proper-lockfile) for concurrent write safety
 * - Read/unread filtering
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TeammateMessage } from "./types.js";
import { getInboxesDir } from "./types.js";

// ============================================================================
// Locking
// ============================================================================

/** Acquire a file lock for the given file path. Returns unlock function. */
async function lock(filePath: string): Promise<() => Promise<void>> {
  // Use simple retry-based locking: poll until lock file disappears
  const lockPath = filePath + ".lock";
  const maxRetries = 30;
  const retryDelay = 50;

  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return async () => {
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
      };
    } catch {
      // Lock exists, wait and retry
      await new Promise((r) => setTimeout(r, retryDelay + Math.random() * 50));
    }
  }
  throw new Error(`Could not acquire lock for ${filePath} after ${maxRetries} retries`);
}

// ============================================================================
// Path Helpers
// ============================================================================

/** Get the file path for a specific agent's inbox */
function getInboxPath(cwd: string, agentName: string, teamName: string): string {
  const safeName = agentName.replace(/[<>:"/\\|?*]/g, "_");
  const dir = getInboxesDir(cwd, teamName);
  return path.join(dir, `${safeName}.json`);
}

/** Ensure the inbox directory exists */
function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// Public API
// ============================================================================

/** Read all messages from an agent's inbox */
export async function readMailbox(
  cwd: string,
  agentName: string,
  teamName: string,
): Promise<TeammateMessage[]> {
  const inboxPath = getInboxPath(cwd, agentName, teamName);
  try {
    const raw = fs.readFileSync(inboxPath, "utf-8");
    return JSON.parse(raw) as TeammateMessage[];
  } catch {
    return [];
  }
}

/** Read only unread messages */
export async function readUnreadMessages(
  cwd: string,
  agentName: string,
  teamName: string,
): Promise<TeammateMessage[]> {
  const all = await readMailbox(cwd, agentName, teamName);
  return all.filter((m) => !m.read);
}

/** Write a message to an agent's inbox */
export async function writeToMailbox(
  cwd: string,
  recipient: string,
  msg: Omit<TeammateMessage, "read">,
  teamName: string,
): Promise<void> {
  const inboxPath = getInboxPath(cwd, recipient, teamName);
  ensureDir(path.dirname(inboxPath));

  const fullMsg: TeammateMessage = { ...msg, read: false };

  const release = await lock(inboxPath);
  try {
    const existing = await readMailbox(cwd, recipient, teamName);
    existing.push(fullMsg);
    fs.writeFileSync(inboxPath, JSON.stringify(existing, null, 2), "utf-8");
  } finally {
    await release();
  }
}

/** Mark a specific message as read by index */
export async function markMessageAsRead(
  cwd: string,
  agentName: string,
  teamName: string,
  index: number,
): Promise<void> {
  const inboxPath = getInboxPath(cwd, agentName, teamName);
  const release = await lock(inboxPath);
  try {
    const all = await readMailbox(cwd, agentName, teamName);
    if (index >= 0 && index < all.length && all[index]) {
      all[index].read = true;
      fs.writeFileSync(inboxPath, JSON.stringify(all, null, 2), "utf-8");
    }
  } finally {
    await release();
  }
}

/** Check if a text payload is a shutdown request */
export function isShutdownRequest(text: string): { request_id: string; from: string; reason?: string } | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.type === "shutdown_request" && typeof parsed.request_id === "string" && typeof parsed.from === "string") {
      return { request_id: parsed.request_id, from: parsed.from, reason: typeof parsed.reason === "string" ? parsed.reason : undefined };
    }
    return null;
  } catch {
    return null;
  }
}

/** Check if a text payload is a permission response */
export function isPermissionResponse(text: string): { request_id: string; subtype: "success" | "error"; response?: Record<string, unknown>; error?: string } | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.type === "permission_response" && typeof parsed.request_id === "string") {
      return {
        request_id: parsed.request_id,
        subtype: parsed.subtype === "error" ? "error" : "success",
        response: parsed.response as Record<string, unknown> | undefined,
        error: typeof parsed.error === "string" ? parsed.error : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Create a shutdown request JSON payload */
export function createShutdownRequest(requestId: string, from: string, reason?: string): string {
  return JSON.stringify({ type: "shutdown_request", request_id: requestId, from, reason });
}

/** Create a shutdown approval response */
export function createShutdownApproval(requestId: string, from: string): string {
  return JSON.stringify({ type: "shutdown_response", request_id: requestId, from, approved: true });
}

/** Create a shutdown rejection response */
export function createShutdownRejection(requestId: string, from: string, reason: string): string {
  return JSON.stringify({ type: "shutdown_response", request_id: requestId, from, approved: false, reason });
}

/** Create an idle notification for the leader */
export function createIdleNotification(
  agentName: string,
  options?: { idleReason?: "available" | "interrupted" | "failed"; summary?: string; completedTaskId?: string },
): string {
  return JSON.stringify({
    type: "idle_notification",
    from: agentName,
    timestamp: new Date().toISOString(),
    ...options,
  });
}