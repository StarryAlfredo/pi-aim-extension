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
import type { TeammateMessage } from "./types.ts";
import { getInboxesDir } from "./types.ts";
import { acquireFileLock } from "./lock.ts";

// ============================================================================
// Mailbox Class
// ============================================================================

/**
 * Manages file-based inbox operations for inter-agent communication.
 * Encapsulates the cwd and team context, providing a cleaner API
 * for mailbox operations.
 */
export class Mailbox {
  readonly #cwd: string;
  readonly #teamName: string;

  constructor(cwd: string, teamName: string) {
    if (typeof cwd !== "string") throw new Error(`Mailbox cwd must be string, got ${typeof cwd}`);
    if (typeof teamName !== "string") throw new Error(`Mailbox teamName must be string, got ${typeof teamName}`);
    this.#cwd = cwd;
    this.#teamName = teamName;
  }

  /**
   * Get the file path for a specific agent's inbox
   */
  private getInboxPath(agentName: string): string {
    const safeName = agentName.replace(/[<>:"/\\|?*]/g, "_");
    const dir = getInboxesDir(this.#cwd, this.#teamName);
    console.log(`getInboxPath: cwd=${this.#cwd}, team=${this.#teamName}, dir=${dir} (type: ${typeof dir})`);
    const fullPath = path.join(dir, `${safeName}.json`);
    console.log(`  fullPath=${fullPath} (type: ${typeof fullPath})`);
    return fullPath;
  }

  /**
   * Read all messages from an agent's inbox
   */
  async read(agentName: string): Promise<TeammateMessage[]> {
    const inboxPath = this.getInboxPath(agentName);
    try {
      const raw = fs.readFileSync(inboxPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as TeammateMessage[];
    } catch {
      return [];
    }
  }

  /**
   * Read only unread messages
   */
  async readUnread(agentName: string): Promise<TeammateMessage[]> {
    const all = await this.read(agentName);
    return all.filter((m) => !m.read);
  }

  /**
   * Write a message to an agent's inbox
   */
  async write(recipient: string, msg: Omit<TeammateMessage, "read">): Promise<void> {
    const inboxPath = this.getInboxPath(recipient);
    const dir = path.dirname(inboxPath);

    // Ensure directory exists BEFORE acquiring lock and writing (safe for concurrent calls)
    // Create all parent directories recursively, ignoring only EEXIST errors
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err: any) {
      // Only ignore "directory already exists" errors
      // Other errors (permission, invalid path) should propagate
      if (err.code !== "EEXIST") throw err;
    }

    const fullMsg: TeammateMessage = { ...msg, read: false };

    const release = await acquireFileLock(inboxPath);
    try {
      const existing = await this.read(recipient);
      existing.push(fullMsg);
      fs.writeFileSync(inboxPath, JSON.stringify(existing, null, 2), "utf-8");
    } finally {
      await release();
    }
  }

  /**
   * Mark a specific message as read by index
   */
  async markAsRead(agentName: string, index: number): Promise<void> {
    const inboxPath = this.getInboxPath(agentName);
    const release = await acquireFileLock(inboxPath);
    try {
      const all = await this.read(agentName);
      if (index >= 0 && index < all.length && all[index]) {
        all[index]!.read = true;
        fs.writeFileSync(inboxPath, JSON.stringify(all, null, 2), "utf-8");
      }
    } finally {
      await release();
    }
  }
}

// ============================================================================
// Backward-Compatible Functional API
// ============================================================================

/**
 * Read all messages from an agent's inbox
 */
export async function readMailbox(
  cwd: string,
  agentName: string,
  teamName: string,
): Promise<TeammateMessage[]> {
  const mailbox = new Mailbox(cwd, teamName);
  return mailbox.read(agentName);
}

/**
 * Read only unread messages
 */
export async function readUnreadMessages(
  cwd: string,
  agentName: string,
  teamName: string,
): Promise<TeammateMessage[]> {
  const mailbox = new Mailbox(cwd, teamName);
  return mailbox.readUnread(agentName);
}

/**
 * Write a message to an agent's inbox
 */
export async function writeToMailbox(
  cwd: string,
  recipient: string,
  msg: Omit<TeammateMessage, "read">,
  teamName: string,
): Promise<void> {
  const mailbox = new Mailbox(cwd, teamName);
  return mailbox.write(recipient, msg);
}

/**
 * Mark a specific message as read by index
 */
export async function markMessageAsRead(
  cwd: string,
  agentName: string,
  teamName: string,
  index: number,
): Promise<void> {
  const mailbox = new Mailbox(cwd, teamName);
  return mailbox.markAsRead(agentName, index);
}

// ============================================================================
// Utility Functions (not part of the class — stateless)
// ============================================================================

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
  options?: { idleReason?: "available" | "interrupted" | "failed" | "completed"; summary?: string; completedTaskId?: string },
): string {
  return JSON.stringify({
    type: "idle_notification",
    from: agentName,
    timestamp: new Date().toISOString(),
    ...options,
  });
}

// ============================================================================
// P2: Structured Message Parsing (unified dispatcher)
// ============================================================================

/** Unified parsed structured message */
export type ParsedStructuredMessage =
  | { kind: "shutdown_request"; requestId: string; from: string; reason?: string }
  | { kind: "shutdown_response"; requestId: string; from: string; approved: boolean; reason?: string }
  | { kind: "plan_approval_request"; requestId: string; from: string; plan: string }
  | { kind: "plan_approval_response"; requestId: string; from: string; approved: boolean; feedback?: string }
  | { kind: "plain_text"; text: string };

/**
 * Parse any inbox message text into a typed structured message.
 * Falls back to plain_text if the text is not JSON or is unknown.
 */
export function parseStructuredMessage(text: string): ParsedStructuredMessage {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const msgType = parsed.type as string | undefined;

    if (msgType === "shutdown_request" && typeof parsed.request_id === "string" && typeof parsed.from === "string") {
      return { kind: "shutdown_request", requestId: parsed.request_id, from: parsed.from, reason: typeof parsed.reason === "string" ? parsed.reason : undefined };
    }
    if (msgType === "shutdown_response" && typeof parsed.request_id === "string" && typeof parsed.from === "string") {
      return { kind: "shutdown_response", requestId: parsed.request_id, from: parsed.from, approved: parsed.approved === true, reason: typeof parsed.reason === "string" ? parsed.reason : undefined };
    }
    if (msgType === "plan_approval_request" && typeof parsed.request_id === "string" && typeof parsed.from === "string") {
      return { kind: "plan_approval_request", requestId: parsed.request_id, from: parsed.from, plan: typeof parsed.plan === "string" ? parsed.plan : "" };
    }
    if (msgType === "plan_approval_response" && typeof parsed.request_id === "string" && typeof parsed.from === "string") {
      return { kind: "plan_approval_response", requestId: parsed.request_id, from: parsed.from, approved: parsed.approved === true, feedback: typeof parsed.feedback === "string" ? parsed.feedback : undefined };
    }
  } catch { /* not JSON — plain text */ }
  return { kind: "plain_text", text };
}

/** Create a plan approval request */
export function createPlanApprovalRequest(requestId: string, from: string, plan: string): string {
  return JSON.stringify({ type: "plan_approval_request", request_id: requestId, from, plan });
}

/** Create a plan approval response */
export function createPlanApprovalResponse(requestId: string, from: string, approved: boolean, feedback?: string): string {
  return JSON.stringify({ type: "plan_approval_response", request_id: requestId, from, approved, feedback });
}
