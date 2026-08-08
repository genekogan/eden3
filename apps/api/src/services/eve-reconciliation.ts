import { pg } from '@eden3/db';

import {
  ensureEveAssistant,
  EVE_RECONCILIATION_ADVISORY_LOCK,
  PLATFORM_EVE_DATABASE_PROFILE,
} from './default-assistant';
import {
  DEFAULT_EVE_OPENCLAW_ID,
  DEFAULT_EVE_USERNAME,
  PLATFORM_EVE_TOOL_GROUPS,
} from './platform-eve';

type PgTransaction = Parameters<Parameters<typeof pg.begin>[1]>[0];
type SqlExecutor = typeof pg | PgTransaction;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDLE = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const SAFE_RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const DATABASE_NAME = /^[A-Za-z0-9_-]{1,63}$/;
const RESERVED_HANDLES = new Set([
  'main',
  DEFAULT_EVE_USERNAME,
  'new',
  'builder',
  'edit',
  'api',
  'media',
]);

let localReconciliationTail: Promise<void> = Promise.resolve();

async function acquireReconciliationLease(): Promise<() => Promise<void>> {
  let releaseLocal!: () => void;
  const predecessor = localReconciliationTail;
  localReconciliationTail = new Promise<void>((resolve) => {
    releaseLocal = resolve;
  });
  await predecessor;

  const connection = await pg.reserve();
  let locked = false;
  try {
    await connection`
      select pg_advisory_lock(hashtextextended(${EVE_RECONCILIATION_ADVISORY_LOCK}, 0))
    `;
    locked = true;
  } catch (error) {
    connection.release();
    releaseLocal();
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      if (locked) {
        await connection`
          select pg_advisory_unlock(hashtextextended(${EVE_RECONCILIATION_ADVISORY_LOCK}, 0))
        `;
      }
    } finally {
      connection.release();
      releaseLocal();
    }
  };
}

export type EveReconciliationState = 'blocked' | 'reconciled' | 'bootstrapped';

export interface EveReconciliationInput {
  expectedDatabaseName: string;
  expectedCollisionAccountId: string;
  expectedCollisionOwnerId: string;
  expectedCollisionOpenclawId: string;
  expectedCollisionHandle: string;
  expectedPlatformAccountId: string;
  expectedPlatformOpenclawId: string;
  expectedPlatformHandle: string;
  newHandle: string;
}

export interface EveReconciliationOptions {
  apply?: boolean;
  /** Deterministic rollback seam used only by the disposable-Postgres battery. */
  afterRenameBeforeCommit?: () => void | Promise<void>;
  /** Deterministic replacement-handle race seam used only by tests. */
  beforeRenameCompareAndSet?: () => void | Promise<void>;
  /** Deterministic cross-phase/concurrency seam used only by tests. */
  afterPhase1CommitBeforeBootstrap?: () => void | Promise<void>;
}

interface IdentityRow {
  accountId: string;
  type: string;
  username: string;
  deleted: boolean;
  ownerId: string | null;
  openclawId: string | null;
  accountStableHash: string;
  agentHash: string;
  bootstrapCanonical: boolean;
}

interface CountsRow {
  eveHandleCount: number;
  mainRuntimeCount: number;
  newHandleCount: number;
}

export interface EveIdentityManifest {
  accountId: string;
  username: string;
  ownerId: string | null;
  openclawId: string;
}

export interface EveReconciliationFingerprints {
  collisionAccountStableHash: string;
  collisionAgentHash: string;
  platformAccountStableHash: string;
  platformAgentHash: string;
  unrelatedAccountsCount: number;
  unrelatedAccountsHash: string;
  unrelatedAgentsCount: number;
  unrelatedAgentsHash: string;
}

export interface EveReconciliationManifest {
  version: 'platform-eve.collision-reconciliation@v1';
  databaseName: string;
  state: EveReconciliationState;
  collision: EveIdentityManifest;
  platform: EveIdentityManifest;
  platformBootstrapCanonical: boolean;
  counts: CountsRow;
  fingerprints: EveReconciliationFingerprints;
}

export class EveReconciliationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly safeDetails?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'EveReconciliationError';
  }
}

function fail(code: string, message: string, safeDetails?: Record<string, unknown>): never {
  throw new EveReconciliationError(code, message, safeDetails);
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function normalizeInput(raw: EveReconciliationInput): EveReconciliationInput {
  const input = {
    expectedDatabaseName: raw.expectedDatabaseName.trim(),
    expectedCollisionAccountId: raw.expectedCollisionAccountId.trim().toLowerCase(),
    expectedCollisionOwnerId: raw.expectedCollisionOwnerId.trim().toLowerCase(),
    expectedCollisionOpenclawId: raw.expectedCollisionOpenclawId.trim(),
    expectedCollisionHandle: raw.expectedCollisionHandle.trim().toLowerCase(),
    expectedPlatformAccountId: raw.expectedPlatformAccountId.trim().toLowerCase(),
    expectedPlatformOpenclawId: raw.expectedPlatformOpenclawId.trim(),
    expectedPlatformHandle: raw.expectedPlatformHandle.trim().toLowerCase(),
    newHandle: raw.newHandle.trim().toLowerCase(),
  };
  if (!DATABASE_NAME.test(input.expectedDatabaseName)) {
    fail('invalid_database_name', 'Expected database name is invalid');
  }
  if (input.expectedDatabaseName === 'eden3') {
    fail('production_database_forbidden', 'The production database is outside this tool\'s scope');
  }
  for (const [field, value] of [
    ['expectedCollisionAccountId', input.expectedCollisionAccountId],
    ['expectedCollisionOwnerId', input.expectedCollisionOwnerId],
    ['expectedPlatformAccountId', input.expectedPlatformAccountId],
  ] as const) {
    if (!UUID.test(value)) fail('invalid_expected_id', `${field} must be a UUID`);
  }
  if (input.expectedCollisionAccountId === input.expectedPlatformAccountId) {
    fail('ambiguous_expected_identity', 'Collision and platform account IDs must differ');
  }
  if (
    !SAFE_RUNTIME_ID.test(input.expectedCollisionOpenclawId) ||
    !SAFE_RUNTIME_ID.test(input.expectedPlatformOpenclawId)
  ) {
    fail('invalid_runtime_id', 'Expected OpenClaw IDs must use the safe runtime-id shape');
  }
  if (input.expectedPlatformOpenclawId !== DEFAULT_EVE_OPENCLAW_ID) {
    fail('invalid_platform_runtime', 'Platform OpenClaw ID must be main');
  }
  if (input.expectedCollisionOpenclawId === DEFAULT_EVE_OPENCLAW_ID) {
    fail('invalid_collision_runtime', 'The user-owned collision cannot own OpenClaw main');
  }
  if (input.expectedCollisionHandle !== DEFAULT_EVE_USERNAME) {
    fail('invalid_collision_handle', 'Expected collision handle must be eve');
  }
  if (!HANDLE.test(input.expectedPlatformHandle) || input.expectedPlatformHandle === DEFAULT_EVE_USERNAME) {
    fail('invalid_platform_handle', 'Expected platform handle must be a non-Eve agent handle');
  }
  if (!HANDLE.test(input.newHandle)) {
    fail(
      'invalid_replacement_handle',
      'Replacement handle must be 3-32 lowercase path-safe characters',
    );
  }
  if (RESERVED_HANDLES.has(input.newHandle)) {
    fail('reserved_replacement_handle', 'Replacement handle is reserved');
  }
  if (
    input.newHandle === input.expectedCollisionHandle ||
    input.newHandle === input.expectedPlatformHandle
  ) {
    fail('replacement_handle_conflict', 'Replacement handle must differ from both current handles');
  }
  return input;
}

async function currentDatabaseName(sql: SqlExecutor): Promise<string> {
  const [row] = await sql<{ name: string }[]>`select current_database() as name`;
  if (!row?.name) fail('database_identity_unavailable', 'Could not resolve current database');
  return row.name;
}

async function identityById(sql: SqlExecutor, accountId: string): Promise<IdentityRow | null> {
  const rows = await sql<IdentityRow[]>`
    select a.id as "accountId", a.type, a.username::text as username, a.deleted,
           g.owner_id as "ownerId", g.openclaw_id as "openclawId",
           md5((to_jsonb(a) - 'username' - 'updated_at')::text) as "accountStableHash",
           md5(to_jsonb(g)::text) as "agentHash",
           (
             g.owner_id is null
             and g.name = ${PLATFORM_EVE_DATABASE_PROFILE.name}
             and g.description = ${PLATFORM_EVE_DATABASE_PROFILE.description}
             and g.persona = ${PLATFORM_EVE_DATABASE_PROFILE.persona}
             and g.is_persona_public = true
             and g.greeting = ${PLATFORM_EVE_DATABASE_PROFILE.greeting}
             and g.public = true
             and g.openclaw_id = ${DEFAULT_EVE_OPENCLAW_ID}
             and g.tool_groups = ${pg.json(JSON.stringify(PLATFORM_EVE_TOOL_GROUPS))}::jsonb
             and g.is_pilot = true
             and g.is_synthetic = false
             and g.provision_status = 'ready'
             and g.provisioned_at is not null
           ) as "bootstrapCanonical"
    from accounts a
    join agents g on g.account_id = a.id
    where a.id = ${accountId}
  `;
  return rows[0] ?? null;
}

async function counts(sql: SqlExecutor, input: EveReconciliationInput): Promise<CountsRow> {
  const [row] = await sql<CountsRow[]>`
    select
      (select count(*)::int from accounts where username = ${DEFAULT_EVE_USERNAME}) as "eveHandleCount",
      (select count(*)::int from agents where openclaw_id = ${DEFAULT_EVE_OPENCLAW_ID}) as "mainRuntimeCount",
      (select count(*)::int from accounts where username = ${input.newHandle}) as "newHandleCount"
  `;
  if (!row) fail('identity_counts_unavailable', 'Could not resolve Eve identity counts');
  return row;
}

async function corpusFingerprints(
  sql: SqlExecutor,
  input: EveReconciliationInput,
): Promise<Pick<
  EveReconciliationFingerprints,
  'unrelatedAccountsCount' | 'unrelatedAccountsHash' | 'unrelatedAgentsCount' | 'unrelatedAgentsHash'
>> {
  const [row] = await sql<{
    unrelatedAccountsCount: number;
    unrelatedAccountsHash: string;
    unrelatedAgentsCount: number;
    unrelatedAgentsHash: string;
  }[]>`
    select
      (select count(*)::int from accounts a
       where a.id not in (${input.expectedCollisionAccountId}, ${input.expectedPlatformAccountId}))
        as "unrelatedAccountsCount",
      (select md5(coalesce(string_agg(md5(to_jsonb(a)::text), '' order by a.id), ''))
       from accounts a
       where a.id not in (${input.expectedCollisionAccountId}, ${input.expectedPlatformAccountId}))
        as "unrelatedAccountsHash",
      (select count(*)::int from agents g
       where g.account_id not in (${input.expectedCollisionAccountId}, ${input.expectedPlatformAccountId}))
        as "unrelatedAgentsCount",
      (select md5(coalesce(string_agg(md5(to_jsonb(g)::text), '' order by g.account_id), ''))
       from agents g
       where g.account_id not in (${input.expectedCollisionAccountId}, ${input.expectedPlatformAccountId}))
        as "unrelatedAgentsHash"
  `;
  if (!row) fail('fingerprints_unavailable', 'Could not compute noninterference fingerprints');
  return row;
}

function stateFor(
  collision: IdentityRow,
  platform: IdentityRow,
  input: EveReconciliationInput,
): EveReconciliationState {
  if (
    collision.username.toLowerCase() === input.expectedCollisionHandle &&
    platform.username.toLowerCase() === input.expectedPlatformHandle
  ) return 'blocked';
  if (
    collision.username.toLowerCase() === input.newHandle &&
    platform.username.toLowerCase() === input.expectedPlatformHandle
  ) return 'reconciled';
  if (
    collision.username.toLowerCase() === input.newHandle &&
    platform.username.toLowerCase() === DEFAULT_EVE_USERNAME
  ) return 'bootstrapped';
  fail('identity_drift', 'Eve identities do not match blocked, reconciled, or bootstrapped state');
}

function validateIdentityRows(
  collision: IdentityRow | null,
  platform: IdentityRow | null,
  input: EveReconciliationInput,
): asserts collision is IdentityRow {
  if (!collision || !platform) fail('identity_not_found', 'An expected account/agent identity is missing');
  if (
    collision.type !== 'agent' ||
    collision.deleted ||
    collision.ownerId !== input.expectedCollisionOwnerId ||
    collision.openclawId !== input.expectedCollisionOpenclawId
  ) {
    fail('collision_identity_mismatch', 'The user-owned collision identity does not match expectations');
  }
  if (
    platform.type !== 'agent' ||
    platform.deleted ||
    platform.ownerId !== null ||
    platform.openclawId !== input.expectedPlatformOpenclawId
  ) {
    fail('platform_identity_mismatch', 'The platform main identity does not match expectations');
  }
}

async function loadManifest(
  sql: SqlExecutor,
  input: EveReconciliationInput,
): Promise<EveReconciliationManifest> {
  const databaseName = await currentDatabaseName(sql);
  if (databaseName !== input.expectedDatabaseName) {
    fail('database_name_mismatch', 'Current database does not match --expected-database-name', {
      expectedDatabaseName: input.expectedDatabaseName,
      currentDatabaseName: databaseName,
    });
  }
  const [collision, platform, identityCounts, corpus] = await Promise.all([
    identityById(sql, input.expectedCollisionAccountId),
    identityById(sql, input.expectedPlatformAccountId),
    counts(sql, input),
    corpusFingerprints(sql, input),
  ]);
  validateIdentityRows(collision, platform, input);
  if (!platform) fail('identity_not_found', 'Expected platform identity is missing');
  const state = stateFor(collision, platform, input);
  if (identityCounts.mainRuntimeCount !== 1) {
    fail('ambiguous_platform_runtime', 'OpenClaw main must resolve to exactly one agent');
  }
  const expectedEveCount = state === 'bootstrapped' ? 1 : state === 'blocked' ? 1 : 0;
  if (identityCounts.eveHandleCount !== expectedEveCount) {
    fail('ambiguous_eve_handle', 'The Eve handle count does not match the expected lifecycle state');
  }
  const expectedNewCount = state === 'blocked' ? 0 : 1;
  if (identityCounts.newHandleCount !== expectedNewCount) {
    fail(
      state === 'blocked' ? 'replacement_handle_exists' : 'ambiguous_replacement_handle',
      'Replacement handle ownership does not match the expected lifecycle state',
    );
  }
  return {
    version: 'platform-eve.collision-reconciliation@v1',
    databaseName,
    state,
    collision: {
      accountId: collision.accountId,
      username: collision.username,
      ownerId: collision.ownerId,
      openclawId: collision.openclawId!,
    },
    platform: {
      accountId: platform.accountId,
      username: platform.username,
      ownerId: platform.ownerId,
      openclawId: platform.openclawId!,
    },
    platformBootstrapCanonical: platform.bootstrapCanonical,
    counts: identityCounts,
    fingerprints: {
      collisionAccountStableHash: collision.accountStableHash,
      collisionAgentHash: collision.agentHash,
      platformAccountStableHash: platform.accountStableHash,
      platformAgentHash: platform.agentHash,
      ...corpus,
    },
  };
}

async function loadManifestSnapshot(
  input: EveReconciliationInput,
): Promise<EveReconciliationManifest> {
  return pg.begin(
    'isolation level repeatable read',
    async (sql) => {
      // Establish the coherent snapshot and hold the selected identities until
      // classification commits. A concurrent selected-row writer either wins
      // before this point and is observed, or waits until after this manifest's
      // linearization point.
      await sql`
        select id from accounts
        where id in (${input.expectedCollisionAccountId}, ${input.expectedPlatformAccountId})
        for share
      `;
      await sql`
        select account_id from agents
        where account_id in (${input.expectedCollisionAccountId}, ${input.expectedPlatformAccountId})
        for share
      `;
      return loadManifest(sql, input);
    },
  );
}

function assertPreserved(
  before: EveReconciliationManifest,
  after: EveReconciliationManifest,
): void {
  for (const key of [
    'collisionAccountStableHash',
    'collisionAgentHash',
    'platformAccountStableHash',
    'platformAgentHash',
    'unrelatedAccountsCount',
    'unrelatedAccountsHash',
    'unrelatedAgentsCount',
    'unrelatedAgentsHash',
  ] as const) {
    if (before.fingerprints[key] !== after.fingerprints[key]) {
      fail('noninterference_violation', `Unexpected fingerprint change: ${key}`);
    }
  }
  if (
    before.collision.accountId !== after.collision.accountId ||
    before.collision.ownerId !== after.collision.ownerId ||
    before.collision.openclawId !== after.collision.openclawId ||
    before.platform.accountId !== after.platform.accountId ||
    before.platform.ownerId !== after.platform.ownerId ||
    before.platform.openclawId !== after.platform.openclawId
  ) {
    fail('identity_binding_changed', 'An immutable Eve identity binding changed');
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function eveReconciliationCommand(input: EveReconciliationInput): string {
  return [
    'pnpm eve:reconcile --',
    '--expected-database-name', shellQuote(input.expectedDatabaseName),
    '--expected-collision-account-id', shellQuote(input.expectedCollisionAccountId),
    '--expected-collision-owner-id', shellQuote(input.expectedCollisionOwnerId),
    '--expected-collision-openclaw-id', shellQuote(input.expectedCollisionOpenclawId),
    '--expected-collision-handle', shellQuote(input.expectedCollisionHandle),
    '--expected-platform-account-id', shellQuote(input.expectedPlatformAccountId),
    '--expected-platform-openclaw-id', shellQuote(input.expectedPlatformOpenclawId),
    '--expected-platform-handle', shellQuote(input.expectedPlatformHandle),
    '--new-handle', shellQuote(input.newHandle),
    '--apply',
  ].join(' ');
}

export type EveReconciliationDryRunResult = {
      dryRun: true;
      state: EveReconciliationState;
      action: 'none';
      manifest: EveReconciliationManifest;
      applyCommand: string;
    };

export type EveReconciliationApplyResult = {
      dryRun: false;
      state: 'bootstrapped';
      action: 'renamed-and-bootstrapped' | 'bootstrapped' | 'verified';
      phase1: {
        action: 'renamed' | 'already-renamed';
        before: EveReconciliationManifest;
        after: EveReconciliationManifest;
      };
      finalManifest: EveReconciliationManifest;
    };

export type EveReconciliationResult =
  | EveReconciliationDryRunResult
  | EveReconciliationApplyResult;

export function reconcileEveCollision(
  rawInput: EveReconciliationInput,
  options?: EveReconciliationOptions & { apply?: false },
): Promise<EveReconciliationDryRunResult>;
export function reconcileEveCollision(
  rawInput: EveReconciliationInput,
  options: EveReconciliationOptions & { apply: true },
): Promise<EveReconciliationApplyResult>;
export function reconcileEveCollision(
  rawInput: EveReconciliationInput,
  options?: EveReconciliationOptions,
): Promise<EveReconciliationResult>;
export async function reconcileEveCollision(
  rawInput: EveReconciliationInput,
  options: EveReconciliationOptions = {},
): Promise<EveReconciliationResult> {
  const input = normalizeInput(rawInput);

  // This check deliberately precedes pg.begin/advisory locks and every write.
  const databaseName = await currentDatabaseName(pg);
  if (databaseName !== input.expectedDatabaseName) {
    fail('database_name_mismatch', 'Current database does not match --expected-database-name', {
      expectedDatabaseName: input.expectedDatabaseName,
      currentDatabaseName: databaseName,
    });
  }

  if (options.apply !== true) {
    const manifest = await loadManifestSnapshot(input);
    return {
      dryRun: true,
      state: manifest.state,
      action: 'none',
      manifest,
      applyCommand: eveReconciliationCommand(input),
    };
  }

  const releaseReconciliationLease = await acquireReconciliationLease();
  try {
  let phase1: EveReconciliationApplyResult['phase1'];
  try {
    phase1 = await pg.begin('isolation level repeatable read', async (sql) => {
      await sql`
        select id from accounts
        where id in (${input.expectedCollisionAccountId}, ${input.expectedPlatformAccountId})
           or username in (
             ${input.expectedCollisionHandle}, ${input.expectedPlatformHandle},
             ${input.newHandle}, ${DEFAULT_EVE_USERNAME}
           )
        for update
      `;
      await sql`
        select account_id from agents
        where account_id in (${input.expectedCollisionAccountId}, ${input.expectedPlatformAccountId})
           or openclaw_id in (${input.expectedCollisionOpenclawId}, ${input.expectedPlatformOpenclawId})
        for update
      `;
      const before = await loadManifest(sql, input);
      const platformBefore = await identityById(sql, input.expectedPlatformAccountId);
      if (!platformBefore?.bootstrapCanonical) {
        fail(
          'platform_bootstrap_would_mutate_agent',
          'Platform main is not already canonical; refusing a bootstrap that would change agent data',
        );
      }
      let action: 'renamed' | 'already-renamed' = 'already-renamed';
      if (before.state === 'blocked') {
        await options.beforeRenameCompareAndSet?.();
        const updated = await sql<{ id: string }[]>`
          update accounts
          set username = ${input.newHandle}, updated_at = now()
          where id = ${input.expectedCollisionAccountId}
            and username = ${input.expectedCollisionHandle}
          returning id
        `;
        if (updated.length !== 1) fail('rename_compare_and_set_lost', 'Collision rename lost its compare-and-set');
        action = 'renamed';
        await options.afterRenameBeforeCommit?.();
      }
      const after = await loadManifest(sql, input);
      if (after.state !== 'reconciled' && after.state !== 'bootstrapped') {
        fail('phase1_not_reconciled', 'Phase 1 did not reach a resumable state');
      }
      assertPreserved(before, after);
      return { action, before, after };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      fail(
        'replacement_handle_raced',
        'Replacement handle became unavailable before the guarded rename committed',
      );
    }
    throw error;
  }

  try {
    await options.afterPhase1CommitBeforeBootstrap?.();
    const bootstrap = await ensureEveAssistant({
      syncWorkspace: false,
      reconciliationLeaseHeld: true,
      existingIdentityPrecondition: {
        accountId: phase1.before.platform.accountId,
        username: phase1.before.platform.username,
        accountStableHash: phase1.before.fingerprints.platformAccountStableHash,
        agentHash: phase1.before.fingerprints.platformAgentHash,
      },
    });
    if (
      bootstrap.accountId !== input.expectedPlatformAccountId ||
      bootstrap.openclawId !== input.expectedPlatformOpenclawId
    ) {
      fail('bootstrap_identity_mismatch', 'Normal Eve bootstrap returned a different identity');
    }
    const finalManifest = await loadManifestSnapshot(input);
    if (finalManifest.state !== 'bootstrapped') {
      fail('bootstrap_verification_failed', 'Normal Eve bootstrap did not reach bootstrapped state');
    }
    assertPreserved(phase1.before, finalManifest);
    const action =
      phase1.before.state === 'blocked'
        ? 'renamed-and-bootstrapped'
        : phase1.before.state === 'reconciled'
          ? 'bootstrapped'
          : 'verified';
    return { dryRun: false, state: 'bootstrapped', action, phase1, finalManifest };
  } catch (error) {
    if (error instanceof EveReconciliationError && error.code === 'noninterference_violation') {
      throw error;
    }
    let manifest: EveReconciliationManifest | null = null;
    try {
      manifest = await loadManifestSnapshot(input);
    } catch {
      // Keep the loud handoff payload bounded if concurrent drift prevents a
      // trustworthy post-failure manifest.
    }
    // An identical concurrent apply may win bootstrap after this run commits
    // phase 1 but before its preconditioned bootstrap acquires the second
    // lock. Converge only after independently verifying the exact terminal
    // identity and every preservation fingerprint; all partial/drifted states
    // remain loud bootstrap_pending failures.
    if (manifest?.state === 'bootstrapped') {
      assertPreserved(phase1.before, manifest);
      return {
        dryRun: false,
        state: 'bootstrapped',
        action: 'verified',
        phase1,
        finalManifest: manifest,
      };
    }
    fail('bootstrap_pending', 'Handle reconciliation committed but normal Eve bootstrap is pending', {
      phase1Action: phase1.action,
      state: manifest?.state ?? 'unknown',
      resumeCommand: eveReconciliationCommand(input),
    });
  }
  } finally {
    await releaseReconciliationLease();
  }
}
