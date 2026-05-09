/**
 * AIM — Task Distributor
 *
 * When a teammate reports idle, the team lead proactively finds
 * and assigns available tasks. This bridges the gap where idle
 * notifications were sent but never consumed.
 *
 * Mirrors Claude Code's design where the lead's inbox poller
 * detects idle teammates and feeds them work from the task list.
 */

import { listTasks, findAvailableTask, claimTask, updateTask, findUnblockedTasks, isAgentBusy, getTask } from "./shared-tasks.js";
import { writeToMailbox } from "./mailbox.js";
import { findLeastBusyAgent, getTeamAgentStatuses, type AgentStatus } from "./agent-status.js";
import { notifyTaskAssignment, type TaskNotification } from "./task-notifications.js";

// ============================================================================
// Types
// ============================================================================

/** Result of a distribution attempt */
export interface DistributionResult {
  /** Whether a task was assigned */
  assigned: boolean;
  /** The agent that received the task (if any) */
  agentName?: string;
  /** The task ID that was assigned (if any) */
  taskId?: string;
  /** Reason if no task was assigned */
  reason?: string;
}

// ============================================================================
// Core Distribution Logic
// ============================================================================

/**
 * Handle an idle notification from a teammate.
 *
 * When a teammate reports idle, we try to find an available task
 * and assign it to them. This is the core of the "push" model:
 * instead of waiting for teammates to poll the task list, the
 * lead proactively pushes work to idle agents.
 *
 * @param cwd Working directory
 * @param teamName Team name
 * @param idleAgentName The agent that reported idle
 * @returns Distribution result
 */
export async function handleIdleAgent(
  cwd: string,
  teamName: string,
  idleAgentName: string,
): Promise<DistributionResult> {
  // Don't assign if the agent is somehow still busy
  // (race condition: they may have claimed a task between
  // sending the idle notification and us processing it)
  if (isAgentBusy(cwd, teamName, idleAgentName)) {
    return { assigned: false, reason: "agent_still_busy" };
  }

  // Find an available task
  const available = findAvailableTask(cwd, teamName);
  if (!available) {
    return { assigned: false, reason: "no_available_tasks" };
  }

  // Try to claim the task for the idle agent
  const result = await claimTask(cwd, teamName, available.id, idleAgentName);
  if ("rejected" in result) {
    return { assigned: false, reason: result.reason };
  }

  // Send assignment notification
  await notifyTaskAssignment(cwd, idleAgentName, teamName, available.id, available.subject, "task-distributor");

  return {
    assigned: true,
    agentName: idleAgentName,
    taskId: available.id,
  };
}

/**
 * Redistribute tasks across the team.
 *
 * Called when:
 * - A new task is created (should find an idle agent)
 * - A task becomes unblocked (dependency completed)
 * - A teammate becomes idle
 *
 * This is the "pull" model complement to handleIdleAgent's "push":
 * given a pool of available tasks, find the best idle agent for each.
 *
 * @param cwd Working directory
 * @param teamName Team name
 * @returns Number of tasks distributed
 */
export async function distributeAvailableTasks(
  cwd: string,
  teamName: string,
): Promise<number> {
  let distributed = 0;

  // Get current team status
  const statuses = getTeamAgentStatuses(cwd, teamName);
  const idleAgents = statuses.filter(a => a.status === "idle");

  if (idleAgents.length === 0) return 0;

  // For each idle agent, try to assign a task
  for (const agent of idleAgents) {
    const available = findAvailableTask(cwd, teamName);
    if (!available) break; // No more tasks to distribute

    const result = await claimTask(cwd, teamName, available.id, agent.agentId);
    if ("task" in result) {
      await notifyTaskAssignment(cwd, agent.agentId, teamName, available.id, available.subject, "task-distributor");
      distributed++;
    }
  }

  return distributed;
}

/**
 * Handle a task completion event by distributing newly unblocked tasks.
 *
 * When a task completes, its dependents may become unblocked.
 * This function finds idle agents for those newly available tasks.
 *
 * @param cwd Working directory
 * @param teamName Team name
 * @param completedTaskId The task that just completed
 * @returns Number of newly unblocked tasks distributed
 */
export async function handleTaskCompleted(
  cwd: string,
  teamName: string,
  completedTaskId: string,
): Promise<number> {
  const unblocked = findUnblockedTasks(cwd, teamName, completedTaskId);
  if (unblocked.length === 0) return 0;

  // Try to assign each unblocked task to an idle agent
  let distributed = 0;
  for (const task of unblocked) {
    if (task.owner) continue; // Already has an owner

    const candidate = findLeastBusyAgent(cwd, teamName);
    if (!candidate || candidate.status !== "idle") break;

    const result = await claimTask(cwd, teamName, task.id, candidate.agentId);
    if ("task" in result) {
      await notifyTaskAssignment(cwd, candidate.agentId, teamName, task.id, task.subject, "task-distributor");
      distributed++;
    }
  }

  return distributed;
}