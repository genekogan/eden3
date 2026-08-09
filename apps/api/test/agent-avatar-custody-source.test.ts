import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const agentsSource = readFileSync(new URL('../src/routes/agents.ts', import.meta.url), 'utf8');
const erasureSource = readFileSync(
  new URL('../src/services/account-erasure-postgres.ts', import.meta.url),
  'utf8',
);
const visibilitySource = readFileSync(
  new URL('../src/services/legacy-media-visibility.ts', import.meta.url),
  'utf8',
);

describe('agent avatar durable custody source contract', () => {
  it('admits avatar publication account-first and retains replaced locators', () => {
    const uploadStart = agentsSource.indexOf("'/:username/avatar'");
    const deleteStart = agentsSource.indexOf("app.delete('/:username/avatar'", uploadStart);
    const upload = agentsSource.slice(uploadStart, deleteStart);
    const remove = agentsSource.slice(deleteStart);

    expect(upload).toContain('await pg.begin(async (tx) =>');
    expect(upload).toContain('for key share');
    expect(upload).toContain('from account_erasure_jobs');
    expect(upload).toContain("state <> 'succeeded'");
    expect(upload).toContain('for update of a, agent');
    expect(upload).toContain('getStore().put');
    expect(upload).toContain('insert into agent_avatar_assets');
    expect(upload).toContain("set state='retired'");
    expect(upload).toContain('update accounts set user_image');
    expect(upload.indexOf('for key share')).toBeLessThan(upload.indexOf('getStore().put'));
    expect(upload.indexOf('from account_erasure_jobs')).toBeLessThan(
      upload.indexOf('getStore().put'),
    );
    expect(upload.indexOf('insert into agent_avatar_assets')).toBeLessThan(
      upload.indexOf('update accounts set user_image'),
    );

    expect(remove).toContain('await pg.begin(async (tx) =>');
    expect(remove).toContain("set state='retired'");
    expect(remove).toContain('update accounts set user_image=null');
  });

  it('inventories avatar history and treats every live avatar as a shared-byte reference', () => {
    expect(erasureSource).toContain("kind: 'legacy_avatar_asset'");
    expect(erasureSource).toContain('from agent_avatar_assets av');
    expect(erasureSource).toContain("select 'legacy_avatar_asset'::text source_kind");
    expect(erasureSource).toContain("target.kind === 'legacy_avatar_asset'");
    expect(erasureSource).toContain("claim.kind === 'legacy_avatar_asset'");
    expect(erasureSource).toContain('delete from agent_avatar_assets');
    expect(erasureSource).toContain('avatarShared');
    expect(visibilitySource).toContain('matching_avatars');
    expect(visibilitySource).toContain("t.kind='legacy_avatar_asset'");
  });
});
