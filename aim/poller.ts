/**
 * AIM — Inbox Poller
 *
 * Continuous polling loop for long-lived agents. Used by teammates
 * to wait for new prompts or shutdown requests.
 *
 * Polls the agent's inbox every 500ms, checking for:
 * - Shutdown request from leader (returned to caller for model decision)
 * - New messages/prompts from leader or peers
 * - Abort signal
 *
 * This keeps the teammate alive in 'idle' state instead of terminating.
 *
 * NOTE: This is intended for long-lived teammates running in RPC mode
 * (not the default print-mode workers). RPC-mode teammates are planned
 * for a future iteration.
 */

import type { AbortSignal } from "node:child_process"; // type only
import { readUnreadMessages, markMessageAsRead } from "./mailbox.js";
import { createIdleNotification, writeToMailbox } from "./mailbox.js";

// ============================================================================
// Polling
// ============================================================================

export type PollResult =
  | { type: "shutdown_request"; request: { request_id: string; from: string; reason?: string }; original: string }
  | { type: "new_message"; message: string; from: string }
  | { type: "aborted" };

/**
 * Blocking poll loop — waits for inbox messages or shutdown signal.
 * Returns when a message is received or the signal is aborted.
 */
export async function pollInbox(
  cwd: string,
  agentName: string,
  teamName: string,
  signal: AbortSignal,
): Promise<PollResult> {
  const POLL_INTERVAL_MS = 500;

  while (!signal.aborted) {
    const unread = await readUnreadMessages(cwd, agentName, teamName);

    // Check unread messages
    for (let i = 0; i < unread.length; i++) {
      const msg = unread[i];
      if (!msg) continue;

      // Check for shutdown requests
      try {
        const parsed = JSON.parse(msg.text) as Record<string, unknown>;
        if (parsed.type === "shutdown_request" && typeof parsed.request_id === "string") {
          await markMessageAsRead(cwd, agentName, teamName, i);
          return {
            type: "shutdown_request",
            request: { request_id: parsed.request_id, from: msg.from, reason: typeof parsed.reason === "string" ? parsed.reason : undefined },
            original: msg.text,
          };
        }
      } catch {
        // Not JSON, treat as regular message
      }

      // Regular message
      await markMessageAsRead(cwd, agentName, teamName, i);
      return { type: "new_message", message: msg.text, from: msg.from };
    }

    // No messages — wait and retry
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return { type: "aborted" };
}

/**
 * Send an idle notification to the team leader.
 * Called after a teammate finishes its current task.
 */
export async function sendIdleNotification(
  cwd: string,
  agentName: string,
  teamName: string,
  options?: { idleReason?: "available" | "interrupted" | "failed"; summary?: string; completedTaskId?: string },
): Promise<void> {
  const payload = createIdleNotification(agentName, options);
  await writeToMailbox(cwd, "team-lead", {
    from: agentName,
    text: payload,
    timestamp: new Date().toISOString(),
  }, teamName);
}