/**
 * AIM — Agent Status Tracking (P1)
 *
 * Tracks which agents are idle vs. busy within a team, based on
 * their open (non-terminal) task ownership.
 *
 * Mirrors Claude Code's AgentStatus design:
 *   - idle: no open tasks
 *   - busy: at least one in_progress / pending (owned) task
 *
 * Used by claimTask for busy-check, by poller for workload balancing,
 * and by UI for agent status display.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { listTasks, isAgentBusy } from "./shared-tasks.js";
import { getTeamsDir, isTerminalStatus } from "./types.js";
import type { TaskItem } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export type AgentBusyState = "idle" | "busy";

/** Status snapshot of a single agent within a team */
export interface AgentStatus {
  /** Agent identifier (matches TaskItem.owner) */
  agentId: string;
  /** Display name */
  name: string;
  /** Agent type if known (from team membership) */
  agentType?: string;
  /** Current busy state */
  status: AgentBusyState;
  /** IDs of open (non-terminal) tasks owned by this agent */
  currentTasks: string[];
  /** Timestamp of the most recent task update */
  lastActiveAt: number;
}

/** Team-wide agent status summary */
export interface TeamAgentStatusSnapshot {
  teamName: string;
  agents: AgentStatus[];
  /** Total open tasks across all agents */
  totalOpenTasks: number;
  /** Number of idle agents */
  idleAgents: number;
  /** Number of busy agents */
  busyAgents: number;
  /** Timestamp of this snapshot */
  capturedAt: number;
}

// ============================================================================
// Agent Status Queries
// ============================================================================

/**
 * Check if a specific agent has any open (non-terminal) tasks.
 * Re-exported from shared-tasks.js for convenience.
 */
export const isAgentBusyStatus = isAgentBusy;

/**
 * Get the status of a single agent within a team.
 */
export function getAgentStatus(cwd: string, team: string, agentName: string): AgentStatus {
  const tasks = listTasks(cwd, team);
  const open = tasks.filter(t =>
    t.owner != null && t.owner === agentName && !isTerminalStatus(t.status),
  );
  const lastActiveAt = open.length > 0
    ? Math.max(...open.map(t => t.updatedAt))
    : 0;

  return {
    agentId: agentName,
    name: agentName,
    status: open.length > 0 ? "busy" : "idle",
    currentTasks: open.map(t => t.id),
    lastActiveAt,
  };
}

/**
 * Get the status of all agents in a team.
 * Agents are inferred from task ownership — any agent that has ever
 * owned a task in this team will appear.
 */
export function getTeamAgentStatuses(cwd: string, team: string): AgentStatus[] {
  const tasks = listTasks(cwd, team);

  // Collect unique owner names from tasks
  const ownerNames = new Set<string>();
  for (const t of tasks) {
    if (t.owner != null) ownerNames.add(t.owner);
  }

  // Also include team members from the team file — newly spawned teammates
  // that haven't claimed any tasks yet won't appear in task ownership data.
  const safeName = team.replace(/[<>:"/\\|?*]/g, "_");
  const teamFilePath = path.join(getTeamsDir(cwd), `${safeName}.json`);
  try {
    const raw = fs.readFileSync(teamFilePath, "utf-8");
    const teamFile = JSON.parse(raw) as import("./types.js").TeamFile;
    for (const member of teamFile.members) {
      ownerNames.add(member.name);
    }
  } catch {
    // Team file doesn't exist or is invalid — fall through to task-only discovery
  }

  return [...ownerNames].map(name => getAgentStatus(cwd, team, name));
}

/**
 * Get a full team status snapshot.
 * Useful for UI display and workload balancing decisions.
 */
export function getTeamStatusSnapshot(cwd: string, team: string): TeamAgentStatusSnapshot {
  const agents = getTeamAgentStatuses(cwd, team);
  const allTasks = listTasks(cwd, team);
  const totalOpen = allTasks.filter(t => !isTerminalStatus(t.status)).length;
  const idle = agents.filter(a => a.status === "idle").length;
  const busy = agents.filter(a => a.status === "busy").length;

  return {
    teamName: team,
    agents,
    totalOpenTasks: totalOpen,
    idleAgents: idle,
    busyAgents: busy,
    capturedAt: Date.now(),
  };
}

/**
 * Find the least busy agent in a team.
 * Returns the agent with the fewest open tasks, or null if no idle agent exists.
 * Among agents with the same number of open tasks, picks the one that has
 * been idle the longest (earliest lastActiveAt).
 *
 * This enables intelligent task distribution in the poller.
 */
export function findLeastBusyAgent(cwd: string, team: string): AgentStatus | null {
  const agents = getTeamAgentStatuses(cwd, team);
  const idleAgents = agents.filter(a => a.status === "idle");
  if (idleAgents.length === 0) return null;

  // Sort: prefer agents with fewer open tasks, then by lastActiveAt ascending.
  // Agents with lastActiveAt === 0 (never used) get highest priority so they
  // are selected before idle agents that were previously active.
  idleAgents.sort((a, b) => {
    if (a.currentTasks.length !== b.currentTasks.length) {
      return a.currentTasks.length - b.currentTasks.length;
    }
    // Never-used agents (lastActiveAt === 0) come first
    const aNeverUsed = a.lastActiveAt === 0;
    const bNeverUsed = b.lastActiveAt === 0;
    if (aNeverUsed !== bNeverUsed) return aNeverUsed ? -1 : 1;
    return a.lastActiveAt - b.lastActiveAt;
  });

  return idleAgents[0] ?? null;
}

/**
 * Get all tasks owned by a specific agent.
 * Uses != null to match both null (legacy) and undefined (current).
 */
export function getAgentOpenTasks(cwd: string, team: string, agentName: string): TaskItem[] {
  const tasks = listTasks(cwd, team);
  return tasks.filter(t =>
    t.owner != null && t.owner === agentName && !isTerminalStatus(t.status),
  );
}

/**
 * Format agent statuses for display.
 * Used by TUI renderers and log output.
 */
export function formatAgentStatuses(snapshot: TeamAgentStatusSnapshot): string {
  const lines: string[] = [
    `📋 Team: ${snapshot.teamName}`,
    `   Open tasks: ${snapshot.totalOpenTasks} | Agents: ${snapshot.busyAgents} busy / ${snapshot.idleAgents} idle`,
    "",
  ];

  if (snapshot.agents.length === 0) {
    lines.push("   (no agents)");
    return lines.join("\n");
  }

  for (const agent of snapshot.agents) {
    const icon = agent.status === "busy" ? "🔴" : "🟢";
    const tasks = agent.currentTasks.length > 0
      ? ` → #${agent.currentTasks.join(", #")}`
      : "";
    lines.push(`   ${icon} ${agent.name}${tasks}`);
  }

  return lines.join("\n");
}