import { existsSync, readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { accountErasureTargets, agentAvatarAssets } from '../src/schema';

const migrationUrl = new URL('../migrations/0043_agent_avatar_asset_custody.sql', import.meta.url);

describe('agent avatar asset custody migration', () => {
  it('adds durable owner/agent/content identity and the erasure target kind', () => {
    expect(existsSync(migrationUrl)).toBe(true);
    const sql = readFileSync(migrationUrl, 'utf8');
    const avatar = getTableConfig(agentAvatarAssets);
    const targets = getTableConfig(accountErasureTargets);

    expect(avatar.name).toBe('agent_avatar_assets');
    expect(avatar.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'id',
      'owner_account_id',
      'agent_account_id',
      'url',
      'local_path',
      'sha256',
      'mime',
      'size_bytes',
      'state',
      'retired_at',
      'created_at',
      'updated_at',
    ]));
    expect(targets.checks.map((entry) => entry.name)).toContain(
      'account_erasure_targets_kind_check',
    );
    expect(sql).toContain("'legacy_avatar_asset'");
    expect(sql).toContain('agent_avatar_assets_one_current_uq');
    expect(sql).toContain('account_erasure_avatar_asset_guard');
    expect(sql).toContain('account_erasure_avatar_source_guard');
    expect(sql).toContain('account_erasure_legacy_content_ingest_fence');
    expect(sql).toContain('account_erasure_target_owned');
  });
});
