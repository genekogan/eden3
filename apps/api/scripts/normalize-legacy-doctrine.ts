/**
 * One-time, lossless normalization for migrated persona/memory values that
 * predate Eden's seven-file context budgets. Default mode is read-only:
 *
 *   tsx scripts/normalize-legacy-doctrine.ts
 *   tsx scripts/normalize-legacy-doctrine.ts --apply
 *
 * Before `--apply`, take and verify a database snapshot. Every changed value's
 * exact original bytes are also copied under workspace memory/legacy/ with a
 * SHA-256 filename and metadata sidecar. The active copy gets a pointer to that
 * searchable archive and is bounded to the doctrine's 20K/file limit.
 */
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { pg } from '@eden3/db';

import { planLegacyDoctrineNormalization } from '../src/services/legacy-doctrine-normalization';

const apply = process.argv.includes('--apply');
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const dataDir = path.resolve(
  process.env.OPENCLAW_DATA_DIR ?? path.join(repoRoot, 'infra', 'openclaw', 'data'),
);

interface AgentRow {
  accountId: string;
  username: string;
  openclawId: string;
  workspacePath: string;
  persona: string | null;
}

interface PlannedChange {
  kind: 'persona' | 'memory';
  agent: AgentRow;
  original: string;
  normalized: string;
  reasons: string[];
  archivePath: string;
  archiveRelPath: string;
}

interface WorkspacePathRepair {
  accountId: string;
  username: string;
  openclawId: string;
  original: string;
  canonical: string;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function assertWorkspacePath(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  if (resolved !== dataDir && !resolved.startsWith(`${dataDir}${path.sep}`)) {
    throw new Error(`refusing workspace path outside ${dataDir}: ${resolved}`);
  }
  return resolved;
}

async function canonicalizeAgentWorkspace(
  agent: AgentRow,
): Promise<{ agent: AgentRow; repair?: WorkspacePathRepair } | undefined> {
  const canonical = path.join(dataDir, `workspace-${agent.openclawId}`);
  const resolved = path.resolve(agent.workspacePath);
  if (resolved === canonical) return { agent: { ...agent, workspacePath: canonical } };

  const legacy = path.join(
    repoRoot,
    'apps',
    'api',
    'infra',
    'openclaw',
    'data',
    `workspace-${agent.openclawId}`,
  );
  if (resolved !== legacy) return undefined;
  await access(canonical);
  return {
    agent: { ...agent, workspacePath: canonical },
    repair: {
      accountId: agent.accountId,
      username: agent.username,
      openclawId: agent.openclawId,
      original: agent.workspacePath,
      canonical,
    },
  };
}

async function planChange(
  kind: PlannedChange['kind'],
  agent: AgentRow,
  original: string,
): Promise<PlannedChange | undefined> {
  const digest = sha256(original);
  const archiveRelPath = `memory/legacy/${kind}-${digest}.md`;
  const normalization = planLegacyDoctrineNormalization(original, archiveRelPath);
  if (!normalization.changed) return undefined;
  const workspacePath = assertWorkspacePath(agent.workspacePath);
  return {
    kind,
    agent,
    original,
    normalized: normalization.content,
    reasons: normalization.reasons,
    archiveRelPath,
    archivePath: path.join(workspacePath, archiveRelPath),
  };
}

async function writeArchive(change: PlannedChange, database: string): Promise<void> {
  await mkdir(path.dirname(change.archivePath), { recursive: true });
  try {
    await writeFile(change.archivePath, change.original, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readFile(change.archivePath, 'utf8');
    if (existing !== change.original) {
      throw new Error(`archive hash collision or corruption at ${change.archivePath}`);
    }
  }
  const metadataPath = `${change.archivePath}.meta.json`;
  const metadata = `${JSON.stringify(
    {
      version: 1,
      database,
      accountId: change.agent.accountId,
      username: change.agent.username,
      openclawId: change.agent.openclawId,
      kind: change.kind,
      originalSha256: sha256(change.original),
      originalChars: change.original.length,
      normalizedChars: change.normalized.length,
      reasons: change.reasons,
      normalizedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`;
  try {
    await writeFile(metadataPath, metadata, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

async function atomicReplace(target: string, expected: string, replacement: string): Promise<void> {
  const current = await readFile(target, 'utf8');
  if (current !== expected) throw new Error(`file changed during normalization: ${target}`);
  const temporary = `${target}.eden3-normalize-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, replacement, { encoding: 'utf8', mode: 0o644 });
  await rename(temporary, target);
}

const [databaseRow] = await pg<{ database: string }[]>`select current_database() as database`;
const database = databaseRow!.database;
const rows = await pg<AgentRow[]>`
  select ag.account_id as "accountId", a.username, ag.openclaw_id as "openclawId",
         ag.workspace_path as "workspacePath", ag.persona
  from agents ag
  join accounts a on a.id = ag.account_id
  where ag.provision_status in ('ready', 'provisioned')
    and ag.openclaw_id is not null
    and ag.workspace_path is not null
  order by a.username
`;

const changes: PlannedChange[] = [];
const workspacePathRepairs: WorkspacePathRepair[] = [];
const skippedOutsideDataDir: { username: string; workspacePath: string }[] = [];
for (const row of rows) {
  const canonicalized = await canonicalizeAgentWorkspace(row).catch(() => undefined);
  if (canonicalized === undefined) {
    skippedOutsideDataDir.push({ username: row.username, workspacePath: row.workspacePath });
    continue;
  }
  const agent = canonicalized.agent;
  if (canonicalized.repair) workspacePathRepairs.push(canonicalized.repair);
  try {
    assertWorkspacePath(agent.workspacePath);
  } catch {
    skippedOutsideDataDir.push({ username: agent.username, workspacePath: agent.workspacePath });
    continue;
  }
  if (agent.persona !== null) {
    const change = await planChange('persona', agent, agent.persona);
    if (change) changes.push(change);
  }
  const memoryPath = path.join(assertWorkspacePath(agent.workspacePath), 'MEMORY.md');
  const memory = await readFile(memoryPath, 'utf8').catch(() => undefined);
  if (memory !== undefined) {
    const change = await planChange('memory', agent, memory);
    if (change) changes.push(change);
  }
}

const summary = changes.map((change) => ({
  kind: change.kind,
  username: change.agent.username,
  openclawId: change.agent.openclawId,
  originalChars: change.original.length,
  normalizedChars: change.normalized.length,
  archive: change.archiveRelPath,
  reasons: change.reasons,
}));
console.log(
  JSON.stringify(
    {
      database,
      apply,
      selectedAgents: rows.length,
      skippedOutsideDataDir,
      workspacePathRepairs,
      changes: summary,
    },
    null,
    2,
  ),
);

if (!apply || (changes.length === 0 && workspacePathRepairs.length === 0)) {
  await pg.end();
  process.exit(0);
}

// Complete every lossless archive first. Only after all archives are durable
// do we change either the active MEMORY.md copies or the database personas.
for (const change of changes) await writeArchive(change, database);
for (const change of changes.filter((item) => item.kind === 'memory')) {
  await atomicReplace(
    path.join(assertWorkspacePath(change.agent.workspacePath), 'MEMORY.md'),
    change.original,
    change.normalized,
  );
}

await pg.begin(async (tx) => {
  for (const repair of workspacePathRepairs) {
    const [locked] = await tx<{ workspacePath: string | null }[]>`
      select workspace_path as "workspacePath"
      from agents where account_id = ${repair.accountId} for update
    `;
    if (locked?.workspacePath !== repair.original) {
      throw new Error(`workspace path changed during normalization: ${repair.username}`);
    }
    await tx`
      update agents set workspace_path = ${repair.canonical}
      where account_id = ${repair.accountId}
    `;
  }
  for (const change of changes.filter((item) => item.kind === 'persona')) {
    const [locked] = await tx<{ persona: string | null }[]>`
      select persona from agents where account_id = ${change.agent.accountId} for update
    `;
    if (locked?.persona !== change.original) {
      throw new Error(`persona changed during normalization: ${change.agent.username}`);
    }
    await tx`
      update agents set persona = ${change.normalized}
      where account_id = ${change.agent.accountId}
    `;
  }
});

console.log(
  `normalized ${changes.length} legacy doctrine value(s) and repaired ` +
    `${workspacePathRepairs.length} legacy workspace path(s) in ${database}; originals archived`,
);
await pg.end();
