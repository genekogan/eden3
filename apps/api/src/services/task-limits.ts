import { ApiError } from '../errors';

/** Hard abuse guard shared by owner-created and agent-created schedules. */
export const MAX_ENABLED_TASKS_PER_AGENT = 10;

export function agentTaskLimitError(agentId: string): ApiError {
  return new ApiError(
    429,
    'agent_task_limit_exceeded',
    `Agent ${agentId} already has ${MAX_ENABLED_TASKS_PER_AGENT} enabled scheduled tasks; pause or delete one before enabling another`,
  );
}
