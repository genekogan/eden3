import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('scheduled-task owner run history', () => {
  it('scopes recorded chat turns to the owner and exposes only safe run fields', () => {
    const source = readFileSync(new URL('../src/routes/triggers.ts', import.meta.url), 'utf8');
    const routeStart = source.indexOf("app.get('/:id/runs'");
    const routeEnd = source.indexOf('// ---- POST /tasks', routeStart);
    const route = source.slice(routeStart, routeEnd);

    expect(routeStart).toBeGreaterThan(0);
    expect(route).toContain('existing.userId !== viewer.accountId');
    expect(route).toContain("event_type = 'chat_turn'");
    expect(route).toContain("metadata->'source'->>'kind' = 'scheduled_task'");
    expect(route).toContain("metadata->'source'->>'triggerId' = ${existing.id}");
    expect(route).toContain('automationMannaSpendLastHour(existing.agentId)');
    expect(route).toContain('AUTOMATION_HOURLY_MANNA_CAP');
    expect(route).not.toContain('error_message');
    expect(route).not.toContain('cost_usd');
    expect(route).not.toContain('provider');
    expect(route).not.toContain('model');
  });
});
