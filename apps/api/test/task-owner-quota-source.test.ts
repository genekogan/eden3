import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('scheduled-task owner quota admission', () => {
  it('uses one owner-lock identity and rechecks the global count inside both create transactions', () => {
    const api = readFileSync(new URL('../src/routes/triggers.ts', import.meta.url), 'utf8');
    const bridge = readFileSync(
      new URL('../../../infra/agent-cron-bridge/server.mjs', import.meta.url),
      'utf8',
    );

    const apiCreate = api.slice(
      api.indexOf('const rowId = await pg.begin'),
      api.indexOf('const [row] = await db.select()', api.indexOf('const rowId = await pg.begin')),
    );
    expect(apiCreate).toMatch(/task-owner:[\s\S]*where user_id[\s\S]*task_quota_exceeded/);
    expect(apiCreate.indexOf('task-owner:')).toBeLessThan(
      apiCreate.indexOf('agentAccount.id}::text'),
    );

    const bridgeCreate = bridge.slice(
      bridge.indexOf('async create(identity, input)'),
      bridge.indexOf('async update(identity, id', bridge.indexOf('async create(identity, input)')),
    );
    expect(bridgeCreate).toMatch(
      /lockOwner\(tx, identity\)[\s\S]*assertOwnerLimitAvailable\(tx, identity\)[\s\S]*lockAgent\(tx, identity\)/,
    );
    expect(bridge).toMatch(
      /const assertOwnerLimitAvailable[\s\S]*where user_id[\s\S]*task_quota_exceeded/,
    );
  });
});
