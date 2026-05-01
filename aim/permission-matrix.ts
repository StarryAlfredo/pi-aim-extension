/**
 * AIM — Permission Matrix
 *
 * Role-based tool filtering that runs at infrastructure level,
 * not relying on LLM prompt compliance.
 *
 * Following Claude Code's design:
 *   COORDINATOR_MODE_ALLOWED_TOOLS  = [agent, task_stop, send_message]
 *   ASYNC_AGENT_ALLOWED_TOOLS       = worker-safe tools (no re-delegation)
 *   IN_PROCESS_TEAMMATE_ALLOWED_TOOLS = worker + collaboration tools
 *   INTERNAL_WORKER_TOOLS           = tools workers MUST NOT have
 */

/** Tools that subagent coordinators are allowed (exclusive set) */
export const COORDINATOR_TOOLS = ["subagent", "task_stop", "send_message"];

/** Tools that workers MUST NOT have (prevent re-delegation loops) */
export const FORBIDDEN_WORKER_TOOLS = new Set([
  "subagent", "agent",
  "send_message",
  "team_create", "team_delete",
  "task_stop",
]);

/** Tools force-injected into teammate agents */
export const TEAMMATE_FORCE_TOOLS = [
  "send_message",
  "team_create", "team_delete",
  "task_create", "task_list", "task_get", "task_update",
];

/**
 * Compute effective tools for a given role.
 *
 * @param role - "worker", "teammate", "coordinator", or "default"
 * @param declaredTools - tools declared in the agent definition file
 * @returns filtered/merged tool list
 */
export function getRoleTools(
  role: "worker" | "teammate" | "coordinator" | "default",
  declaredTools: string[],
): string[] {
  switch (role) {
    case "coordinator":
      return COORDINATOR_TOOLS;

    case "teammate": {
      const tools = new Set(declaredTools);
      for (const t of TEAMMATE_FORCE_TOOLS) tools.add(t);
      return Array.from(tools);
    }

    case "worker":
      return declaredTools.filter(t => !FORBIDDEN_WORKER_TOOLS.has(t));

    default:
      return declaredTools;
  }
}

/**
 * Determine the role from agent definition context.
 * Coordinator mode is detected separately (system prompt injection).
 */
export type AgentRole = "worker" | "teammate" | "coordinator" | "default";

export function resolveRole(params: {
  isTeammate?: boolean;
  isCoordinator?: boolean;
  isFork?: boolean;
}): AgentRole {
  if (params.isCoordinator) return "coordinator";
  if (params.isTeammate) return "teammate";
  // Fork agents are workers with parent context
  if (params.isFork) return "worker";
  return "worker"; // default: regular subagent = worker role
}