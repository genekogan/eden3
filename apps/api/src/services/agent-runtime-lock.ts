export const AGENT_RUNTIME_SYNC_LOCK_SEED = 92;

export function agentRuntimeSyncLockKey(accountId: string): string {
  return `eden3:agent-runtime-sync:${accountId}`;
}
