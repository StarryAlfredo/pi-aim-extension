/**
 * AIM — Task Distributor
 *
 * When a teammate reports idle, the team lead proactively finds
 * and assigns available tasks. This bridges the gap where idle
 * notifications were sent but never consumed.
 *
 * Mirrors Claude Code's design where the lead's inbox poller
 * detects idle teammates and feeds them work from the task list.
 *
 * Refactor: the three free functions all threaded `(cwd, team, ...)` and
 * each called 4–6 functions on the same context (listTasks, findAvailableTask,
 * claimTask, isAgentBusy, findLeastBusyAgent, notifyTaskAssignment, …). They
 * are now methods on `TaskDistributor`, which composes a `TaskStore`,
 * `AgentStatusManager`, and `TaskNotifier` once at construction — eliminating
 * all context threading from the distribution logic.
 */

import { TaskStore } from "./shared-tasks.js";
import { AgentStatusManager, type AgentStatus } from "./agent-status.js";
import { TaskNotifier } from "./task-notifications.js";

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
// TaskDistributor Class
// ============================================================================

/**
 * Pushes available tasks to idle teammates for a single (cwd, team) context.
 * Composes the task store, agent-status manager, and notifier so distribution
 * logic never threads cwd/team through every call.
 */
export class TaskDistributor {
  private readonly store: TaskStore;
  private readonly statuses: AgentStatusManager;
  private readonly notifier: TaskNotifier;

  constructor(
    private readonly cwd: string,
    private readonly team: string,
  ) {
    this.store = new TaskStore(cwd, team);
    this.statuses = new AgentStatusManager(cwd, team);
    this.notifier = new TaskNotifier(cwd, team);
  }

  /**
   * Handle an idle notification from a teammate.
   *
   * When a teammate reports idle, we try to find an available task
   * and assign it to them. This is the core of the "push" model:
   * instead of waiting for teammates to poll the task list, the
   * lead proactively pushes work to idle agents.
   */
  async handleIdleAgent(idleAgentName: string): Promise<DistributionResult> {
    // Don't assign if the agent is somehow still busy
    // (race condition: they may have claimed a task between
    // sending the idle notification and us processing it)
    if (this.store.isAgentBusy(idleAgentName)) {
      return { assigned: false, reason: "agent_still_busy" };
    }

    // Find an available task
    const available = this.store.findAvailableTask();
    if (!available) {
      return { assigned: false, reason: "no_available_tasks" };
    }

    // Try to claim the task for the idle agent
    const result = await this.store.claimTask(available.id, idleAgentName);
    if ("rejected" in result) {
      return { assigned: false, reason: result.reason };
    }

    // Send assignment notification
    await this.notifier.notifyAssignment(idleAgentName, available.id, available.subject, "task-distributor");

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
   * @returns Number of tasks distributed
   */
  async distributeAvailableTasks(): Promise<number> {
    let distributed = 0;

    // Get current team status
    const statuses = this.statuses.getTeamAgentStatuses();
    const idleAgents = statuses.filter(a => a.status === "idle");

    if (idleAgents.length === 0) return 0;

    // For each idle agent, try to assign a task.
    // Retry up to 3 times per agent in case another agent claims the
    // same task concurrently (claimTask is atomic but findAvailableTask
    // is not — it always returns the lowest-ID available task).
    // Track task IDs that failed to claim for this agent to avoid retrying the same task
    const skippedTaskIds = new Set<string>();

    for (const agent of idleAgents) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const available = this.store.findAvailableTask();
        if (!available) break; // No more tasks to distribute

        // Skip tasks we already failed to claim — another agent likely owns it
        if (skippedTaskIds.has(available.id)) {
          // The lowest-ID available task is one we can't claim — no point retrying
          // unless a new task becomes available. Break and try next agent.
          break;
        }

        const result = await this.store.claimTask(available.id, agent.agentId);
        if ("task" in result) {
          await this.notifier.notifyAssignment(agent.agentId, available.id, available.subject, "task-distributor");
          distributed++;
          break; // Success — move to next agent
        }
        // Claim failed — remember this task ID to avoid retrying
        skippedTaskIds.add(available.id);
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
   * @returns Number of newly unblocked tasks distributed
   */
  async handleTaskCompleted(completedTaskId: string): Promise<number> {
    const unblocked = this.store.findUnblockedTasks(completedTaskId);
    if (unblocked.length === 0) return 0;

    // Try to assign each unblocked task to an idle agent
    let distributed = 0;
    for (const task of unblocked) {
      if (task.owner) continue; // Already has an owner

      const candidate = this.statuses.findLeastBusyAgent();
      if (!candidate || candidate.status !== "idle") break;

      const result = await this.store.claimTask(task.id, candidate.agentId);
      if ("task" in result) {
        await this.notifier.notifyAssignment(candidate.agentId, task.id, task.subject, "task-distributor");
        distributed++;
      }
    }

    return distributed;
  }
}

// ============================================================================
// Backward-Compatible Functional API (thin facades over TaskDistributor)
// ============================================================================

export async function handleIdleAgent(
  cwd: string,
  teamName: string,
  idleAgentName: string,
): Promise<DistributionResult> {
  return new TaskDistributor(cwd, teamName).handleIdleAgent(idleAgentName);
}

export async function distributeAvailableTasks(
  cwd: string,
  teamName: string,
): Promise<number> {
  return new TaskDistributor(cwd, teamName).distributeAvailableTasks();
}

export async function handleTaskCompleted(
  cwd: string,
  teamName: string,
  completedTaskId: string,
): Promise<number> {
  return new TaskDistributor(cwd, teamName).handleTaskCompleted(completedTaskId);
}
