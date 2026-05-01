/**
 * AIM — Swarm Commands & Message Router
 *
 * User-facing layer for swarm team management. Provides:
 *   - @agent-name message routing (forward user input to teammate)
 *   - /swarm init/add/kill/list commands (team lifecycle)
 *
 * Follows Claude Code's swarm UX pattern.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createTeam, deleteTeam, spawnTeammate, getActiveTeam } from "./teams.js";
import { discoverAgents } from "./agents.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Message Router (exposed for external use)
// ============================================================================

export interface RoutedMessage {
  targets: string[];
  content: string;
  isBroadcast: boolean;
}

/**
 * Parse user input for @agent-name mentions.
 * Returns null if no valid @mention found (passthrough to normal chat).
 */
export function parseMessageRouter(input: string, activeTeamAgents: string[]): RoutedMessage | null {
  const atPattern = /@(\S+)(?:\s|$)/g;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = atPattern.exec(input)) !== null) {
    const name = match[1];
    if (name === "*" || name === "all") {
      return { targets: activeTeamAgents, content: input.replace(/@\S+\s*/g, "").trim(), isBroadcast: true };
    }
    if (activeTeamAgents.includes(name)) {
      mentions.push(name);
    }
  }

  if (mentions.length === 0) return null;
  return { targets: mentions, content: input.replace(/@\S+\s*/g, "").trim(), isBroadcast: false };
}

// ============================================================================
// Swarm Command Parser
// ============================================================================

interface SwarmCommand {
  action: "init" | "add" | "kill" | "list" | "unknown";
  teamName?: string;
  agentType?: string;
  agentName?: string;
  description?: string;
}

function parseSwarmCommand(input: string): SwarmCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/swarm")) return null;

  const parts = trimmed.split(/\s+/);
  const action = parts[1];

  switch (action) {
    case "init": return { action: "init", teamName: parts[2], description: parts.slice(3).join(" ") || undefined };
    case "add":  return { action: "add", agentType: parts[2], agentName: parts[3] };
    case "kill": return { action: "kill", agentName: parts[2] };
    case "list": return { action: "list" };
    default:     return { action: "unknown" };
  }
}

// ============================================================================
// Command Handlers
// ============================================================================

async function handleSwarmInit(ctx: ExtensionContext, teamName: string, description?: string): Promise<string> {
  if (!teamName) return "Usage: /swarm init <team-name> [description]";
  const team = await createTeam(ctx.cwd, teamName, description);
  return `Team "${team.name}" created. Lead: ${team.leadAgentId}. Use /swarm add to invite agents.`;
}

async function handleSwarmAdd(ctx: ExtensionContext, agentType?: string, agentName?: string): Promise<string> {
  if (!agentType || !agentName) return "Usage: /swarm add <agent-type> <agent-name>";

  const { agents } = discoverAgents(ctx.cwd, "both");
  const agentDef = agents.find(a => a.name === agentType);
  if (!agentDef) {
    const available = agents.map(a => a.name).join(", ") || "none";
    return `Unknown agent type "${agentType}". Available: ${available}.`;
  }

  const spawned = await spawnTeammate(ctx.cwd, {
    name: agentName, prompt: `You are ${agentName}. Wait for tasks via inbox.`,
    agent_type: agentType, team_name: getActiveTeam()?.name,
  }, agents);

  return `Teammate "${spawned.name}" spawned in team "${spawned.team}". ID: ${spawned.agentId}`;
}

async function handleSwarmKill(ctx: ExtensionContext, agentName?: string): Promise<string> {
  if (!agentName) return "Usage: /swarm kill <agent-name>";

  const activeTeam = getActiveTeam();
  if (!activeTeam) return "No active team. Use /swarm init first.";

  // Read team file, remove member, re-write
  const teamPath = path.join(ctx.cwd, ".pi", "aim", "teams", activeTeam.name + ".json");
  try {
    const team = JSON.parse(fs.readFileSync(teamPath, "utf-8"));
    const idx = team.members.findIndex((m: { name: string }) => m.name === agentName);
    if (idx === -1) return `Agent "${agentName}" not found in team "${activeTeam.name}".`;
    const member = team.members[idx];
    team.members.splice(idx, 1);
    fs.writeFileSync(teamPath, JSON.stringify(team, null, 2), "utf-8");

    // Try to kill the worker process
    const { workerPool } = await import("./worker-pool.js");
    workerPool.kill(member.agentId);

    return `Agent "${agentName}" removed from team "${activeTeam.name}".`;
  } catch {
    return `Failed to remove agent "${agentName}".`;
  }
}

async function handleSwarmList(ctx: ExtensionContext): Promise<string> {
  const activeTeam = getActiveTeam();
  if (!activeTeam) return "No active team. Use /swarm init to create one.";

  const teamPath = path.join(ctx.cwd, ".pi", "aim", "teams", activeTeam.name + ".json");
  try {
    const team = JSON.parse(fs.readFileSync(teamPath, "utf-8"));
    const lines = [`Team: ${team.name} (leader: ${activeTeam.leadAgentId})`];
    if (team.description) lines.push(`  Description: ${team.description}`);
    for (const m of team.members) {
      lines.push(`  - ${m.name} (${m.agentType ?? "unknown"}) since ${new Date(m.joinedAt).toLocaleTimeString()}`);
    }
    return lines.join("\n");
  } catch {
    return "Could not read team info.";
  }
}

// ============================================================================
// Registration
// ============================================================================

export function registerSwarm(pi: ExtensionAPI) {
  // Register /swarm command
  pi.registerCommand("swarm", {
    description: "Manage swarm team (init, add, kill, list)",
    handler: async (args, ctx) => {
      const input = typeof args === "string" ? args : "";
      const cmd = parseSwarmCommand("/swarm " + input);
      if (!cmd) return;

      let response: string;
      switch (cmd.action) {
        case "init":  response = await handleSwarmInit(ctx, cmd.teamName!, cmd.description); break;
        case "add":   response = await handleSwarmAdd(ctx, cmd.agentType, cmd.agentName); break;
        case "kill":  response = await handleSwarmKill(ctx, cmd.agentName); break;
        case "list":  response = await handleSwarmList(ctx); break;
        default:      response = "Unknown /swarm command. Use: init, add, kill, list."; break;
      }

      ctx.ui.notify(response, "info");
    },
  });
}