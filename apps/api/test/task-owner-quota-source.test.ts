import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('scheduled-task owner quota admission', () => {
  it('uses one owner-lock identity and rechecks the global count inside both create transactions', () => {
    const api = readFileSync(new URL('../src/routes/triggers.ts', import.meta.url), 'utf8');
    const bridge = readFileSync(
      new URL('../../../infra/agent-cron-bridge/server.mjs', import.meta.url),
      'utf8',
    );

    for (const source of [api, bridge]) {
      expect(source).toContain('task-owner:');
      expect(source).toMatch(/pg_advisory_xact_lock[\s\S]{0,500}where user_id/);
      expect(source).toContain("code: 'task_quota_exceeded'");
    }
    expect(api.indexOf('task-owner:')).toBeLessThan(api.indexOf('agentAccount.id}::text'));
    expect(bridge.indexOf('task-owner:')).toBeLessThan(
      bridge.indexOf('identity.agentAccountId}::text'),
    );
  });
});
