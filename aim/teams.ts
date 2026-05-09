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
import { getTeamsDir, getTasksDir, getInboxesDir, type AgentConfig } from "./types.js";
import { writeToMailbox } from "./mailbox.js";
import { workerPool } from "./worker-pool.js";
import { runTeammateLoop } from "./teammate-loop.js";

// ============================================================================
// Module State
// ============================================================================

/** Currently active team for the leader (initialized to null to prevent TDZ) */
let activeTeam: { name: string; filePath: string; leadAgentId: string } | null = null;

/** Track abort controllers for each team's teammate loops */
const teamAbortControllers = new Map<string, AbortController[]>();

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
  // 1. Terminate all teammate loops
  const controllers = teamAbortControllers.get(name) ?? [];
  for (const ac of controllers) { try { ac.abort(); } catch {} }
  teamAbortControllers.delete(name);

  // 2. Delete tasks directory
  const tasksDir = getTasksDir(cwd, name);
  try { if (fs.existsSync(tasksDir)) fs.rmSync(tasksDir, { recursive: true }); } catch {}

  // 3. Delete inboxes
  const inboxesDir = getInboxesDir(cwd, name);
  try { if (fs.existsSync(inboxesDir)) fs.rmSync(inboxesDir, { recursive: true }); } catch {}

  // 4. Delete team file
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

  // P2: Pass team_name to the worker config so the child process
  // can detect it's a teammate (via TEAMMATE_TEAM env var set by
  // worker-pool.ts). This enables mailbox-based permission requests.
  const workerInfo = workerPool.getInfo(workerId);
  if (workerInfo) {
    (workerInfo.config as unknown as Record<string, unknown>).team_name = teamName;
  }

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

  // Start autonomous poll loop — teammate will read inbox and claim tasks
  // on its own, without coordinator pushing prompts.
  const loopSignal = new AbortController();
  
  // Register to team's abort controller list
  const controllers = teamAbortControllers.get(teamName) ?? [];
  controllers.push(loopSignal);
  teamAbortControllers.set(teamName, controllers);
  
  runTeammateLoop({
    cwd: config.cwd ?? cwd, agentName: config.name, teamName, workerId, signal: loopSignal.signal,
  }).catch(() => {}); // fire-and-forget, runs until shutdown

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