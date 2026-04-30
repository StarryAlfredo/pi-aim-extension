/**
 * AIM — Inbox Poller (P2 enhanced)
 *
 * Continuous polling loop for long-lived agents. Used by teammates
 * to wait for new prompts, shutdown requests, or available tasks.
 *
 * Priority:
 *   1. Shutdown requests       (highest — always respond first)
 *   2. Team-lead messages       (leader coordination)
 *   3. Peer messages            (other workers)
 *   4. Task list claim          (available tasks)
 *
 * P2 additions:
 *   - Structured message parsing (shutdown_request, plan_approval)
 *   - Task list polling and claiming
 *   - Idle notification to leader
 */

import { readUnreadMessages, markMessageAsRead, parseStructuredMessage } from "./mailbox.js";
import { writeToMailbox, createIdleNotification } from "./mailbox.js";
import { findAvailableTask, claimTask } from "./shared-tasks.js";

// ============================================================================
// Types
// ============================================================================

export type PollResult =
  | { type: "shutdown_request"; request: { requestId: string; from: string; reason?: string }; original: string }
  | { type: "new_message"; message: string; from: string; isStructured: boolean; structured?: ReturnType<typeof parseStructuredMessage> }
  | { type: "task_claimed"; taskId: string; subject: string; prompt: string }
  | { type: "aborted" };

// ============================================================================
// Main Poller
// ============================================================================

/**
 * Blocking poll loop — waits for inbox messages, shutdown signal, or available tasks.
 * Returns when something is found or the signal is aborted.
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

    // --- Priority 1: Shutdown requests ---
    let shutdownIdx = -1;
    let shutdownParsed: ReturnType<typeof parseStructuredMessage> | null = null;
    for (let i = 0; i < unread.length; i++) {
      const msg = unread[i];
      if (!msg) continue;
      const parsed = parseStructuredMessage(msg.text);
      if (parsed.kind === "shutdown_request") {
        shutdownIdx = i;
        shutdownParsed = parsed;
        break;
      }
    }

    if (shutdownIdx !== -1 && shutdownParsed?.kind === "shutdown_request") {
      const msg = unread[shutdownIdx]!;
      await markMessageAsRead(cwd, agentName, teamName, shutdownIdx);
      return {
        type: "shutdown_request",
        request: {
          requestId: shutdownParsed.requestId,
          from: shutdownParsed.from,
          reason: shutdownParsed.reason,
        },
        original: msg.text,
      };
    }

    // --- Priority 2: Team-lead messages ---
    let leadIdx = -1;
    for (let i = 0; i < unread.length; i++) {
      if (unread[i]?.from === "team-lead") { leadIdx = i; break; }
    }
    if (leadIdx !== -1) {
      const msg = unread[leadIdx]!;
      const parsed = parseStructuredMessage(msg.text);
      await markMessageAsRead(cwd, agentName, teamName, leadIdx);
      return { type: "new_message", message: msg.text, from: msg.from, isStructured: parsed.kind !== "plain_text", structured: parsed };
    }

    // --- Priority 3: Peer messages ---
    let peerIdx = -1;
    for (let i = 0; i < unread.length; i++) {
      if (unread[i]?.from !== "team-lead") { peerIdx = i; break; }
    }
    if (peerIdx !== -1) {
      const msg = unread[peerIdx]!;
      const parsed = parseStructuredMessage(msg.text);
      await markMessageAsRead(cwd, agentName, teamName, peerIdx);
      return { type: "new_message", message: msg.text, from: msg.from, isStructured: parsed.kind !== "plain_text", structured: parsed };
    }

    // --- Priority 4: Task list claim ---
    if (teamName) {
      const available = findAvailableTask(cwd, teamName);
      if (available) {
        const claimed = await claimTask(cwd, teamName, available.id, agentName);
        if (claimed) {
          const prompt = `Complete task #${claimed.id}: ${claimed.subject}\n\n${claimed.description || ""}`;
          return { type: "task_claimed", taskId: claimed.id, subject: claimed.subject, prompt };
        }
      }
    }

    // Nothing found — wait and retry
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return { type: "aborted" };
}

/**
 * Send an idle notification to the team leader.
 */
export async function sendIdleNotification(
  cwd: string,
  agentName: string,
  teamName: string,
  options?: { idleReason?: "available" | "interrupted" | "failed"; summary?: string; completedTaskId?: string },
): Promise<void> {
  const payload = createIdleNotification(agentName, options);
  await writeToMailbox(cwd, "team-lead", {
    from: agentName, text: payload, timestamp: new Date().toISOString(),
  }, teamName);
}