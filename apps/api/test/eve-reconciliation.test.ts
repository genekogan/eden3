import { randomUUID } from 'node:crypto';

import { loadRootEnv, pg } from '@eden3/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { parseEveReconciliationArgs } from '../src/eve-reconcile';
import { ensureEveAssistant } from '../src/services/default-assistant';
import {
  EveReconciliationError,
  reconcileEveCollision,
  type EveReconciliationInput,
} from '../src/services/eve-reconciliation';

loadRootEnv();

let sequence = 0;
const fixtureExternalPrefix = `eve_reconcile_${Date.now()}`;

interface Fixture {
  input: EveReconciliationInput;
  collisionAccountId: string;
  platformAccountId: string;
  ownerId: string;
  newHandle: string;
}

async function cleanup(): Promise<void> {
  await pg`
    delete from agents where account_id in (
      select id from accounts where external_id like ${`${fixtureExternalPrefix}%`}
    )
  `;
  await pg`delete from accounts where external_id like ${`${fixtureExternalPrefix}%`}`;
}

async function seedFixture(): Promise<Fixture> {
  sequence += 1;
  const tag = `${sequence}_${Math.random().toString(36).slice(2, 8)}`;
  const [database] = await pg<{ name: string }[]>`select current_database() as name`;
  const [owner] = await pg<{ id: string }[]>`
    insert into accounts (type, username, external_id)
    values ('user', ${`owner_${tag}`}, ${`${fixtureExternalPrefix}_${tag}_owner`})
    returning id
  `;
  const [platform] = await pg<{ id: string }[]>`
    insert into accounts (type, username, external_id)
    values ('agent', 'eden', ${`${fixtureExternalPrefix}_${tag}_platform`})
    returning id
  `;
  await pg`
    insert into agents (account_id, owner_id, name, openclaw_id, provision_status)
    values (${platform!.id}, null, 'Eden', 'main', 'ready')
  `;
  // Canonicalize the platform agent through the real bootstrap, then recreate
  // the staging precondition: the same main account is still named @eden and
  // a separate user-owned agent owns @eve.
  await ensureEveAssistant({ syncWorkspace: false });
  await pg`update accounts set username = 'eden', updated_at = now() where id = ${platform!.id}`;
  const [collision] = await pg<{ id: string }[]>`
    insert into accounts (type, username, external_id, user_image)
    values ('agent', 'eve', ${`${fixtureExternalPrefix}_${tag}_collision`}, '/media/collision.png')
    returning id
  `;
  const collisionOpenclawId = `legacy-${tag}`;
  await pg`
    insert into agents (
      account_id, owner_id, name, description, persona, greeting, voice,
      openclaw_id, workspace_path, public, runtime_sync_version,
      runtime_synced_version, provision_status
    ) values (
      ${collision!.id}, ${owner!.id}, 'Legacy Eve', 'preserve description',
      'preserve persona', 'preserve greeting', 'preserve voice',
      ${collisionOpenclawId}, ${`/workspace/${collisionOpenclawId}`}, false, 7, 6, 'ready'
    )
  `;
  const [unrelatedOwner] = await pg<{ id: string }[]>`
    insert into accounts (type, username, external_id)
    values ('user', ${`other_${tag}`}, ${`${fixtureExternalPrefix}_${tag}_unrelated_owner`})
    returning id
  `;
  const [unrelatedAgent] = await pg<{ id: string }[]>`
    insert into accounts (type, username, external_id)
    values ('agent', ${`agent_${tag}`}, ${`${fixtureExternalPrefix}_${tag}_unrelated_agent`})
    returning id
  `;
  await pg`
    insert into agents (account_id, owner_id, name, persona, openclaw_id, provision_status)
    values (
      ${unrelatedAgent!.id}, ${unrelatedOwner!.id}, 'Unrelated',
      'unrelated data must remain unchanged', ${`other-${tag}`}, 'ready'
    )
  `;
  const newHandle = `legacy_eve_${tag}`;
  return {
    collisionAccountId: collision!.id,
    platformAccountId: platform!.id,
    ownerId: owner!.id,
    newHandle,
    input: {
      expectedDatabaseName: database!.name,
      expectedCollisionAccountId: collision!.id,
      expectedCollisionOwnerId: owner!.id,
      expectedCollisionOpenclawId: collisionOpenclawId,
      expectedCollisionHandle: 'eve',
      expectedPlatformAccountId: platform!.id,
      expectedPlatformOpenclawId: 'main',
      expectedPlatformHandle: 'eden',
      newHandle,
    },
  };
}

async function identityRows(fixture: Fixture) {
  return await pg<{
    accountId: string;
    username: string;
    ownerId: string | null;
    openclawId: string | null;
    accountStableHash: string;
    agentHash: string;
  }[]>`
    select a.id as "accountId", a.username::text as username,
           g.owner_id as "ownerId", g.openclaw_id as "openclawId",
           md5((to_jsonb(a) - 'username' - 'updated_at')::text) as "accountStableHash",
           md5(to_jsonb(g)::text) as "agentHash"
    from accounts a join agents g on g.account_id = a.id
    where a.id in (${fixture.collisionAccountId}, ${fixture.platformAccountId})
    order by a.id
  `;
}

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pg.end({ timeout: 5 });
});

describe('Eve collision reconciliation', () => {
  it('parses a fully explicit dry-run by default and requires --apply for mutation', () => {
    const args = [
      '--expected-database-name', 'scratch_eve',
      '--expected-collision-account-id', '00000000-0000-4000-8000-000000000001',
      '--expected-collision-owner-id', '00000000-0000-4000-8000-000000000002',
      '--expected-collision-openclaw-id', 'legacy-eve',
      '--expected-collision-handle', 'eve',
      '--expected-platform-account-id', '00000000-0000-4000-8000-000000000003',
      '--expected-platform-openclaw-id', 'main',
      '--expected-platform-handle', 'eden',
      '--new-handle', 'legacy_eve',
    ];
    expect(parseEveReconciliationArgs(args)).toMatchObject({ apply: false });
    expect(parseEveReconciliationArgs([...args, '--apply'])).toMatchObject({ apply: true });
    expect(() => parseEveReconciliationArgs(args.slice(0, -2))).toThrow('Missing required --new-handle');
  });

  it('is dry-run by default and emits a blocked manifest without mutation', async () => {
    const fixture = await seedFixture();
    const before = await identityRows(fixture);
    const result = await reconcileEveCollision(fixture.input);
    const after = await identityRows(fixture);

    expect(result).toMatchObject({ dryRun: true, state: 'blocked', action: 'none' });
    expect(result.manifest.databaseName).toBe(fixture.input.expectedDatabaseName);
    expect(result.manifest.collision).toMatchObject({
      accountId: fixture.collisionAccountId,
      ownerId: fixture.ownerId,
      username: 'eve',
    });
    expect(result.manifest.platform).toMatchObject({
      accountId: fixture.platformAccountId,
      ownerId: null,
      username: 'eden',
      openclawId: 'main',
    });
    expect(JSON.stringify(result)).not.toContain('preserve persona');
    expect(after).toEqual(before);
  });

  it('renames only the user-owned collision, bootstraps the exact main account, and preserves hashes', async () => {
    const fixture = await seedFixture();
    const result = await reconcileEveCollision(fixture.input, { apply: true });

    expect(result).toMatchObject({
      dryRun: false,
      state: 'bootstrapped',
      action: 'renamed-and-bootstrapped',
      phase1: { action: 'renamed' },
    });
    expect(result.phase1.before.fingerprints.collisionAccountStableHash).toBe(
      result.phase1.after.fingerprints.collisionAccountStableHash,
    );
    expect(result.phase1.before.fingerprints.collisionAgentHash).toBe(
      result.phase1.after.fingerprints.collisionAgentHash,
    );
    expect(result.phase1.before.fingerprints.unrelatedAccountsHash).toBe(
      result.finalManifest.fingerprints.unrelatedAccountsHash,
    );
    expect(result.phase1.before.fingerprints.unrelatedAgentsHash).toBe(
      result.finalManifest.fingerprints.unrelatedAgentsHash,
    );
    expect(result.finalManifest.collision).toMatchObject({
      accountId: fixture.collisionAccountId,
      ownerId: fixture.ownerId,
      username: fixture.newHandle,
      openclawId: fixture.input.expectedCollisionOpenclawId,
    });
    expect(result.finalManifest.platform).toMatchObject({
      accountId: fixture.platformAccountId,
      ownerId: null,
      username: 'eve',
      openclawId: 'main',
    });

    const resumed = await reconcileEveCollision(fixture.input, { apply: true });
    expect(resumed).toMatchObject({ state: 'bootstrapped', phase1: { action: 'already-renamed' } });
  });

  it('fails closed when the replacement handle already exists and changes nothing', async () => {
    const fixture = await seedFixture();
    await pg`
      insert into accounts (type, username, external_id)
      values ('user', ${fixture.newHandle}, ${`${fixtureExternalPrefix}_${sequence}_handle_collision`})
    `;
    const before = await identityRows(fixture);
    await expect(reconcileEveCollision(fixture.input, { apply: true })).rejects.toMatchObject({
      code: 'replacement_handle_exists',
    } satisfies Partial<EveReconciliationError>);
    expect(await identityRows(fixture)).toEqual(before);
  });

  it('fails closed on a wrong expected identity without touching the real collision', async () => {
    const fixture = await seedFixture();
    const before = await identityRows(fixture);
    await expect(
      reconcileEveCollision(
        { ...fixture.input, expectedCollisionAccountId: randomUUID() },
        { apply: true },
      ),
    ).rejects.toMatchObject({ code: 'identity_not_found' } satisfies Partial<EveReconciliationError>);
    expect(await identityRows(fixture)).toEqual(before);
  });

  it('refuses a wrong database name before locking or writing', async () => {
    const fixture = await seedFixture();
    const before = await identityRows(fixture);
    await expect(
      reconcileEveCollision(
        { ...fixture.input, expectedDatabaseName: `${fixture.input.expectedDatabaseName}_wrong` },
        { apply: true },
      ),
    ).rejects.toMatchObject({ code: 'database_name_mismatch' } satisfies Partial<EveReconciliationError>);
    expect(await identityRows(fixture)).toEqual(before);
  });

  it('rolls the rename back when failure is injected before phase-1 commit', async () => {
    const fixture = await seedFixture();
    const before = await identityRows(fixture);
    await expect(
      reconcileEveCollision(fixture.input, {
        apply: true,
        afterRenameBeforeCommit: () => {
          throw new Error('injected reconciliation failure');
        },
      }),
    ).rejects.toThrow('injected reconciliation failure');
    expect(await identityRows(fixture)).toEqual(before);
  });

  it('serializes concurrent identical runs and converges on one preserved result', async () => {
    const fixture = await seedFixture();
    let releaseFirst!: () => void;
    let firstCommitted!: () => void;
    const committed = new Promise<void>((resolve) => { firstCommitted = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = reconcileEveCollision(fixture.input, {
      apply: true,
      afterPhase1CommitBeforeBootstrap: async () => {
        firstCommitted();
        await release;
      },
    });
    await committed;
    const second = await reconcileEveCollision(fixture.input, { apply: true });
    releaseFirst();
    const firstResult = await first;

    expect(second.state).toBe('bootstrapped');
    expect(firstResult.state).toBe('bootstrapped');
    expect(new Set([
      second.finalManifest.collision.accountId,
      firstResult.finalManifest.collision.accountId,
    ])).toEqual(new Set([fixture.collisionAccountId]));
    expect(second.finalManifest.fingerprints.unrelatedAccountsHash).toBe(
      firstResult.finalManifest.fingerprints.unrelatedAccountsHash,
    );
  });

  it('returns a loud resumable command when phase 1 commits but bootstrap is pending', async () => {
    const fixture = await seedFixture();
    let pending: EveReconciliationError | null = null;
    try {
      await reconcileEveCollision(fixture.input, {
        apply: true,
        afterPhase1CommitBeforeBootstrap: () => {
          throw new Error('injected bootstrap outage');
        },
      });
    } catch (error) {
      pending = error as EveReconciliationError;
    }
    expect(pending).toMatchObject({
      code: 'bootstrap_pending',
      safeDetails: { phase1Action: 'renamed', state: 'reconciled' },
    });
    expect(pending?.safeDetails?.resumeCommand).toBeTypeOf('string');
    expect(pending?.safeDetails?.resumeCommand).toContain("--expected-collision-handle 'eve'");
    expect(pending?.safeDetails?.resumeCommand).toContain(`--new-handle '${fixture.newHandle}' --apply`);
    expect(JSON.stringify(pending?.safeDetails)).not.toContain('preserve persona');

    const [collision] = await pg<{ username: string }[]>`
      select username::text as username from accounts where id = ${fixture.collisionAccountId}
    `;
    const [platform] = await pg<{ username: string }[]>`
      select username::text as username from accounts where id = ${fixture.platformAccountId}
    `;
    expect(collision?.username).toBe(fixture.newHandle);
    expect(platform?.username).toBe('eden');
    await expect(reconcileEveCollision(fixture.input, { apply: true })).resolves.toMatchObject({
      state: 'bootstrapped',
      phase1: { action: 'already-renamed' },
    });
  });

  it('rejects invalid, reserved, drifted, and differently resumed handles', async () => {
    const fixture = await seedFixture();
    for (const newHandle of ['EVIL SPACE', 'main', 'eve', 'new', 'eden']) {
      await expect(
        reconcileEveCollision({ ...fixture.input, newHandle }),
      ).rejects.toBeInstanceOf(EveReconciliationError);
    }
    await pg`update accounts set username = 'different_resume' where id = ${fixture.collisionAccountId}`;
    await expect(reconcileEveCollision(fixture.input, { apply: true })).rejects.toMatchObject({
      code: 'identity_drift',
    } satisfies Partial<EveReconciliationError>);
  });
});
