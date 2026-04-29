/**
 * AIM — Team Management
 *
 * Creates and manages teams of agents. A team groups subagents under a
 * shared namespace with a leader, task list, and inboxes.
 *
 * Workflow:
 *   1. Leader calls team_create → team file + task list directory created
 *   2. Leader calls subagent with team_name → spawns teammate in the team
 *   3. Teammates communicate via mailbox (send_message tool)
 *   4. Teammates auto-claim tasks from the shared task list
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { TeamFile, TeamMember, SpawnTeammateConfig } from "./types.js";
import { getTeamsDir, getTasksDir, type AgentConfig } from "./types.js";
import { writeToMailbox } from "./mailbox.js";
import { workerPool } from "./worker-pool.js";

// ============================================================================
// Module State
// ============================================================================

/** Currently active team for the leader */
let activeTeam: { name: string; filePath: string; leadAgentId: string } | null = null;

// ============================================================================
// File I/O
// ============================================================================

function getTeamFilePath(cwd: string, teamName: string): string {
  const safeName = teamName.replace(/[<>:"/\\|?*]/g, "_");
  return path.join(getTeamsDir(cwd), `${safeName}.json`);
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function readTeamFile(cwd: string, teamName: string): Promise<TeamFile | null> {
  const filePath = getTeamFilePath(cwd, teamName);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as TeamFile;
  } catch {
    return null;
  }
}

async function writeTeamFile(cwd: string, teamName: string, team: TeamFile): Promise<void> {
  const filePath = getTeamFilePath(cwd, teamName);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(team, null, 2), "utf-8");
}

// ============================================================================
// Public API
// ============================================================================

export function getActiveTeam(): { name: string; filePath: string; leadAgentId: string } | null {
  return activeTeam;
}

export async function createTeam(cwd: string, name: string, description?: string): Promise<TeamFile> {
  if (activeTeam) {
    throw new Error(`Already leading team "${activeTeam.name}". Use team_delete first.`);
  }

  const leadAgentId = randomUUID();
  const team: TeamFile = {
    name,
    description,
    createdAt: Date.now(),
    leadAgentId,
    members: [
      { agentId: leadAgentId, name: "team-lead", joinedAt: Date.now(), cwd },
    ],
  };

  await writeTeamFile(cwd, name, team);
  ensureDir(getTasksDir(cwd, name));

  activeTeam = { name, filePath: getTeamFilePath(cwd, name), leadAgentId };
  return team;
}

export async function deleteTeam(cwd: string, name: string): Promise<void> {
  const filePath = getTeamFilePath(cwd, name);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  if (activeTeam?.name === name) activeTeam = null;
}

export async function spawnTeammate(
  cwd: string,
  config: SpawnTeammateConfig,
  agents: AgentConfig[],
): Promise<{ agentId: string; name: string; team: string }> {
  const teamName = config.team_name ?? activeTeam?.name;
  if (!teamName) throw new Error("No active team. Create one first with team_create.");

  const agentDef = agents.find((a) => a.name === config.agent_type);

  // Spawn via WorkerPool
  const fullPrompt = `You are agent "${config.name}" in team "${teamName}".\n\n` +
    (agentDef?.systemPrompt ? `## Role\n${agentDef.systemPrompt}\n\n` : "") +
    `## Task\n${config.prompt}`;

  const tools = agentDef?.tools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"];

  const workerId = workerPool.spawn({
    name: config.name,
    prompt: fullPrompt,
    model: config.model ?? agentDef?.model,
    tools,
    cwd: config.cwd ?? cwd,
    background: true,
  });

  // Register in team file
  const team = await readTeamFile(cwd, teamName);
  if (team) {
    team.members.push({
      agentId: workerId,
      name: config.name,
      agentType: config.agent_type,
      model: config.model,
      color: config.color,
      joinedAt: Date.now(),
      cwd: config.cwd ?? cwd,
    });
    await writeTeamFile(cwd, teamName, team);
  }

  // Send initial prompt via mailbox
  await writeToMailbox(cwd, config.name, {
    from: "team-lead",
    text: fullPrompt,
    timestamp: new Date().toISOString(),
    summary: config.description ?? `Task for ${config.name}`,
  }, teamName);

  return { agentId: workerId, name: config.name, team: teamName };
}

// ============================================================================
// Registration
// ============================================================================

export function registerTeams(pi: ExtensionAPI) {
  pi.registerTool({
    name: "team_create",
    label: "Create Team",
    description: "Create a new team for coordinating multiple agents",
    promptSnippet: "Create a multi-agent team with a leader and shared task list",
    promptGuidelines: [
      "Use team_create before spawning teammates to establish a shared namespace.",
      "Only one team can be active at a time. Use team_delete to end the current team.",
    ],
    parameters: Type.Object({
      team_name: Type.String({ description: "Name for the new team" }),
      description: Type.Optional(Type.String({ description: "Team purpose/description" })),
    }),

    async execute(_toolCallId, params, _signal, ctx) {
      const team = await createTeam(ctx.cwd, params.team_name, params.description);
      return {
        content: [{
          type: "text",
          text: `Team "${team.name}" created. Lead agent: ${team.leadAgentId}. Use subagent with team_name to add members.`,
        }],
        details: { team_name: team.name, lead_agent_id: team.leadAgentId },
      };
    },
  });

  pi.registerTool({
    name: "team_delete",
    label: "Delete Team",
    description: "Delete the current team",
    parameters: Type.Object({
      team_name: Type.String({ description: "Name of the team to delete" }),
    }),

    async execute(_toolCallId, params, _signal, ctx) {
      await deleteTeam(ctx.cwd, params.team_name);
      return {
        content: [{ type: "text", text: `Team "${params.team_name}" deleted.` }],
        details: { deleted: true },
      };
    },
  });
}