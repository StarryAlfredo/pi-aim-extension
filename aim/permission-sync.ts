/**
 * AIM — Permission Sync
 *
 * Allows teammate processes to request permission approvals from the
 * team lead via the mailbox system. When a teammate encounters a
 * dangerous command (e.g. rm, sudo), instead of failing silently,
 * it sends a permission_request to the lead's mailbox and polls
 * its own mailbox for the response.
 *
 * This mirrors Claude Code's swarmWorkerHandler + permissionSync design:
 *   1. Teammate intercepts dangerous tool call
 *   2. Creates permission_request and writes to lead's mailbox
 *   3. Polls own mailbox for permission_response
 *   4. Lead's inbox poller (lead-poller.ts) finds the request
 *   5. Lead presents to user, sends response back
 *   6. Teammate receives response and continues or aborts
 *
 * Usage in permissions.ts:
 *   const result = await requestPermissionViaMailbox(cwd, agentName, teamName, toolName, args, signal);
 *   if (result.approved) { /* proceed */ } else { /* abort */ }
 */

import { writeToMailbox, readUnreadMessages, markMessageAsRead } from "./mailbox.js";
import { createPermissionRequestPayload } from "./lead-poller.js";

// ============================================================================
// Types
// ============================================================================

/** Result of a permission request */
export interface PermissionResult {
  /** Whether the permission was approved */
  approved: boolean;
  /** Reason for rejection (if denied) */
  reason?: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum time to wait for a permission response (ms) */
const PERMISSION_TIMEOUT_MS = 120_000; // 2 minutes

/** Polling interval while waiting for permission response (ms) */
const PERMISSION_POLL_INTERVAL_MS = 500;

// ============================================================================
// Permission Request
// ============================================================================

/**
 * Send a permission request to the team lead and wait for a response.
 *
 * This is called from a teammate process when it encounters a dangerous
 * tool call that requires user approval. The request is sent via the
 * mailbox system, and the function blocks until a response is received
 * or the timeout expires.
 *
 * @param cwd Working directory
 * @param agentName The requesting agent's name
 * @param teamName Team name
 * @param toolName The tool that needs permission (e.g. "bash")
 * @param toolArgs The tool arguments (e.g. { command: "rm -rf ..." })
 * @param signal Abort signal for cancellation
 * @returns Permission result (approved or denied)
 */
export async function requestPermissionViaMailbox(
  cwd: string,
  agentName: string,
  teamName: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<PermissionResult> {
  // Generate a unique request ID for correlation
  const requestId = `perm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // Send the permission request to the lead's mailbox
  const payload = createPermissionRequestPayload(requestId, toolName, toolArgs, agentName);
  await writeToMailbox(cwd, "team-lead", {
    from: agentName,
    text: payload,
    timestamp: new Date().toISOString(),
  }, teamName);

  // Poll own mailbox for the response
  const startTime = Date.now();

  while (!signal?.aborted) {
    // Check timeout
    if (Date.now() - startTime > PERMISSION_TIMEOUT_MS) {
      return {
        approved: false,
        reason: `Permission request timed out after ${PERMISSION_TIMEOUT_MS / 1000}s`,
      };
    }

    // Read unread messages looking for the permission response
    const unread = await readUnreadMessages(cwd, agentName, teamName);

    for (let i = 0; i < unread.length; i++) {
      const msg = unread[i];
      if (!msg || msg.from !== "team-lead") continue;

      try {
        const parsed = JSON.parse(msg.text) as Record<string, unknown>;
        if (parsed.type === "permission_response" && parsed.request_id === requestId) {
          // Found our response — mark as read and return
          await markMessageAsRead(cwd, agentName, teamName, i);

          const approved = parsed.subtype === "success";
          const error = typeof parsed.error === "string" ? parsed.error : undefined;

          return {
            approved,
            reason: approved ? undefined : (error ?? "Permission denied by team lead"),
          };
        }
      } catch {
        // Not valid JSON — skip
      }
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, PERMISSION_POLL_INTERVAL_MS));
  }

  return {
    approved: false,
    reason: "Permission request cancelled (signal aborted)",
  };
}

// ============================================================================
// Identity Check
// ============================================================================

/**
 * Check if the current process is a teammate (not the team lead).
 *
 * This is used by permissions.ts to decide whether to:
 *   - Show a local confirmation dialog (team lead)
 *   - Send a permission request via mailbox (teammate)
 *
 * Detection strategy:
 *   1. Check for TEAMMATE_NAME environment variable (set by spawnTeammate)
 *   2. Check for TEAMMATE_TEAM environment variable
 *   3. If both are set, this process is a teammate
 */
export function isTeammateProcess(): { isTeammate: boolean; agentName?: string; teamName?: string } {
  const agentName = process.env.TEAMMATE_NAME;
  const teamName = process.env.TEAMMATE_TEAM;

  if (agentName && teamName) {
    return { isTeammate: true, agentName, teamName };
  }

  return { isTeammate: false };
}

/**
 * Check if the current process is a teammate and needs to request
 * permissions via the mailbox system.
 *
 * Returns true if:
 *   - The process has TEAMMATE_NAME and TEAMMATE_TEAM env vars
 *   - There is no local TUI available for direct confirmation
 */
export function needsMailboxPermission(): boolean {
  return isTeammateProcess().isTeammate;
}