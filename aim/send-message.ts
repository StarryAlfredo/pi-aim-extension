/**
 * AIM — SendMessage Tool
 *
 * LLM-callable tool for inter-agent communication.
 * Routes messages to agent inboxes via the mailbox system.
 *
 * Supports:
 * - Point-to-point messages
 * - Broadcast to all team members ("*")
 * - Structured protocol messages (shutdown, permission responses)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { readMailbox, writeToMailbox } from "./mailbox.js";
import { getActiveTeam, readTeamFile } from "./teams.js";

// ============================================================================
// Schema
// ============================================================================

export const SendMessageParams = Type.Object({
  to: Type.String({ description: 'Recipient: agent name, or "*" for broadcast to all teammates' }),
  message: Type.String({ description: "Plain text message content" }),
  summary: Type.Optional(Type.String({ description: "5-10 word summary shown as preview in the UI" })),
});

// ============================================================================
// Registration
// ============================================================================

export function registerSendMessage(pi: ExtensionAPI) {
  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description: [
      "Send a message to another agent's inbox.",
      'Use \'to: "*"\' to broadcast to all teammates in the current team.',
      "Messages arrive as user-role messages in the recipient's conversation.",
    ].join(" "),
    promptSnippet: "Send a message to another agent or broadcast to all teammates",
    promptGuidelines: [
      "Use send_message to communicate with spawned subagents and teammates.",
      "Always include a brief summary for messages that trigger agent work.",
      'Use to: "*" to broadcast a message to all teammates (shutdown, coordination).',
    ],
    parameters: SendMessageParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const activeTeam = getActiveTeam();
      const teamName = activeTeam?.name ?? "";

      if (params.to === "*") {
        // Broadcast: send to every member of the active team.
        if (!activeTeam) {
          throw new Error("No active team. Broadcast requires an active team — create one with team_create first.");
        }
        const teamFile = await readTeamFile(cwd, activeTeam.name);
        const members = teamFile?.members ?? [];
        if (members.length === 0) {
          return {
            content: [{ type: "text", text: `📡 Broadcast: team "${activeTeam.name}" has no members.` }],
            details: { success: true, mode: "broadcast", count: 0, team: activeTeam.name },
          };
        }
        let delivered = 0;
        for (const member of members) {
          try {
            await writeToMailbox(cwd, member.name, {
              from: "user",
              text: params.message,
              timestamp: new Date().toISOString(),
              summary: params.summary,
            }, activeTeam.name);
            delivered++;
          } catch {
            // Skip members whose inbox cannot be written (e.g. invalid name).
          }
        }
        return {
          content: [{ type: "text", text: `📡 Broadcast delivered to ${delivered} of ${members.length} member${members.length === 1 ? "" : "s"} of team "${activeTeam.name}".` }],
          details: { success: delivered > 0, mode: "broadcast", count: delivered, team: activeTeam.name },
        };
      }

      // Point-to-point: try RPC steer first, fall back to mailbox
      // Check if target is an active RPC worker in WorkerPool
      const { workerPool } = await import("./worker-pool.js");
      const targetWorker = workerPool.getAll().find(
        (w) => w.config.name === params.to && w.state !== "dead" && w.rpcSend
      );

      if (targetWorker && targetWorker.config.workerId) {
        // Direct RPC steer for immediate delivery
        const steered = workerPool.steer(targetWorker.config.workerId, params.message);
        if (steered) {
          return {
            content: [{
              type: "text",
              text: `Message delivered to ${params.to} via RPC steer.`,
            }],
            details: { success: true, recipient: params.to, method: "rpc_steer" },
          };
        }
      }

      // Fallback: write to file inbox (worker may poll it later)
      await writeToMailbox(cwd, params.to, {
        from: "user",
        text: params.message,
        timestamp: new Date().toISOString(),
        summary: params.summary,
      }, teamName);

      return {
        content: [{
          type: "text",
          text: `Message sent to ${params.to}'s inbox.`,
        }],
        details: { success: true, recipient: params.to, method: "mailbox" },
      };
    },

    renderCall(args, theme, _context) {
      const preview = args.summary ?? (args.message.length > 60 ? `${args.message.slice(0, 60)}...` : args.message);
      let text = theme.fg("toolTitle", theme.bold("send_message "));
      text += args.to === "*"
        ? theme.fg("accent", "broadcast")
        : theme.fg("accent", `→ ${args.to}`);
      text += theme.fg("dim", ` ${preview}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as { success: boolean; recipient?: string; mode?: string } | undefined;
      const icon = details?.success ? theme.fg("success", "✓") : theme.fg("error", "✗");
      let text = `${icon} ${theme.fg("dim", details?.recipient ? `Message sent to ${details.recipient}` : "Broadcast")}`;
      return new Text(text, 0, 0);
    },
  });
}