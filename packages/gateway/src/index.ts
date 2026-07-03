// @eden3/gateway — typed clients + lifecycle tooling for the OpenClaw gateway:
//   OpenClawCompatClient — streaming chat turns (/v1/chat/completions, SSE)
//   OpenClawToolsClient  — /tools/invoke (async media tools, sessions_history)
//   OpenClawCli          — docker exec CLI wrapper (--json parsing)
//   AgentProvisioner     — workspace render + agents add + routability check
//   config-gen           — openclaw.json read-merge-write (baseline, models)
//   CronSync             — eden3 trigger ↔ gateway cron reconciliation
export * from './types';
export * from './compat-client';
export * from './tools-client';
export * from './docker';
export * from './config-gen';
export * from './provisioner';
export * from './cron-sync';
