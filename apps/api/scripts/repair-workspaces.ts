/**
 * Disk-only workspace repair: preflight then render each provisioned pilot's
 * workspace from the templates + DB persona WITHOUT any gateway calls (no
 * agent load → no seed-clobber), write the setupCompletedAt marker, and remove
 * any seeded BOOTSTRAP.md. Existing MEMORY.md, enabled HEARTBEAT.md, and the
 * memory/ tree are preserved. Run this, then restart the gateway once so
 * already-resident agents reload from the corrected files.
 *
 *   tsx scripts/repair-workspaces.ts        # all provisioned pilots
 *   tsx scripts/repair-workspaces.ts --all-registered   # all provisioned DB agents
 *   tsx scripts/repair-workspaces.ts --all-registered --check   # fleet-wide dry run
 */
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pg } from '@eden3/db';
import {
  BOOTSTRAP_FILE_NAMES,
  lintPersonaDoctrine,
  type BootstrapFileName,
  type BootstrapFileSet,
} from '@eden3/shared';
import {
  assertBootstrapSuppressionInvariants,
  assertWorkspacePersonaDoctrine,
  renderTemplate,
} from '@eden3/gateway';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DATA_DIR = process.env.OPENCLAW_DATA_DIR ?? path.join(REPO_ROOT, 'infra', 'openclaw', 'data');
const TEMPLATES_DIR = fileURLToPath(new URL('../../../packages/gateway/workspace-templates/', import.meta.url));
const CONTENT_FILES = [...BOOTSTRAP_FILE_NAMES];
const allRegistered = process.argv.includes('--all-registered');
const checkOnly = process.argv.includes('--check');

const rows = await pg<{
  openclawId: string; username: string; name: string | null; description: string | null;
  persona: string | null; greeting: string | null; voice: string | null; thinkingLevel: string | null;
  workspacePath: string;
}[]>`
  select ag.openclaw_id as "openclawId", a.username, ag.name, ag.description, ag.persona,
         ag.greeting, ag.voice, ag.thinking_level as "thinkingLevel",
         ag.workspace_path as "workspacePath"
  from agents ag join accounts a on a.id = ag.account_id
  where ag.provision_status in ('ready', 'provisioned')
    and ag.openclaw_id is not null
    and ag.workspace_path like ${`${DATA_DIR}/%`}
    and (${allRegistered} or ag.is_pilot)
  order by a.username asc
`;

const templates = new Map<string, string>();
for (const f of CONTENT_FILES) {
  templates.set(f, await readFile(path.join(TEMPLATES_DIR, f), 'utf8'));
}

interface RepairPlan {
  openclawId: string;
  wsDir: string;
  provisionedAt: string;
  existingMemory: string;
  existingHeartbeat: string;
  rendered: BootstrapFileSet;
}

// Build and lint the prospective result for the entire selected fleet before
// mutating even the first workspace. This makes one bad legacy persona a clean
// global refusal instead of a half-completed repair run.
const plans: RepairPlan[] = [];
const invalid: string[] = [];
for (const r of rows) {
  const wsDir = path.resolve(r.workspacePath);
  const expectedWsDir = path.join(DATA_DIR, `workspace-${r.openclawId}`);
  if (wsDir !== expectedWsDir) {
    throw new Error(`refusing non-canonical workspace path for ${r.openclawId}: ${wsDir}`);
  }
  const provisionedAt = new Date().toISOString();
  const vars: Record<string, string> = {
    NAME: r.name ?? r.username,
    USERNAME: r.username,
    DESCRIPTION: r.description ?? '',
    PERSONA: r.persona ?? `You are ${r.name ?? r.username}, an agent on Eden.`,
    GREETING: r.greeting ?? '',
    VOICE: r.voice ?? 'unspecified',
    THINKING_LEVEL: r.thinkingLevel ?? 'balanced',
    MEMORY_SEED: '',
    PROVISIONED_AT: provisionedAt,
  };

  // MEMORY.md and a deliberately enabled HEARTBEAT.md are user/runtime state,
  // not DB-derived scaffolding. Preserve them byte-for-byte. Per-user memory
  // lives below memory/users/ and is never touched by this script.
  const existingMemory = await readFile(path.join(wsDir, 'MEMORY.md'), 'utf8').catch(() => '');
  const existingHeartbeat = await readFile(path.join(wsDir, 'HEARTBEAT.md'), 'utf8').catch(() => '');
  const rendered = {} as BootstrapFileSet;
  for (const f of CONTENT_FILES) {
    const preserved =
      f === 'MEMORY.md' && existingMemory.trim() !== ''
        ? existingMemory
        : f === 'HEARTBEAT.md' && existingHeartbeat.trim() !== ''
          ? existingHeartbeat
          : undefined;
    rendered[f] = preserved ?? renderTemplate(templates.get(f)!, vars);
  }

  // Fail closed before the first mkdir/write/rm. A legacy DB persona can carry
  // an oversized or banned phrase; discovering that only after rewriting six
  // files would leave a partially repaired live workspace.
  const issues = lintPersonaDoctrine(rendered);
  if (issues.length > 0) {
    invalid.push(
      `${r.openclawId}: ${issues.map((issue) => issue.message).join('; ')}`,
    );
    continue;
  }

  plans.push({
    openclawId: r.openclawId,
    wsDir,
    provisionedAt,
    existingMemory,
    existingHeartbeat,
    rendered,
  });
}

if (invalid.length > 0) {
  throw new Error(
    `refusing fleet repair because ${invalid.length} prospective workspace(s) violate ` +
      `persona doctrine:\n- ${invalid.join('\n- ')}`,
  );
}

if (checkOnly) {
  console.log(
    `checked ${plans.length} ${allRegistered ? 'registered' : 'pilot'} workspaces: ` +
      'all prospective seven-file sets are persona-doctrine compliant; no files changed.',
  );
  await pg.end();
  process.exit(0);
}

let fixed = 0;
const regressed: string[] = [];
for (const plan of plans) {
  const { openclawId, wsDir, provisionedAt, existingMemory, existingHeartbeat, rendered } = plan;

  await mkdir(path.join(wsDir, 'memory', 'users'), { recursive: true });
  for (const f of CONTENT_FILES) {
    if (f === 'MEMORY.md' && existingMemory.trim() !== '') continue;
    if (f === 'HEARTBEAT.md' && existingHeartbeat.trim() !== '') continue;
    await writeFile(path.join(wsDir, f), rendered[f as BootstrapFileName], 'utf8');
  }
  await writeFile(
    path.join(wsDir, 'openclaw-workspace-state.json'),
    JSON.stringify({ version: 1, setupCompletedAt: provisionedAt }, null, 2) + '\n',
    'utf8',
  );
  await rm(path.join(wsDir, 'BOOTSTRAP.md'), { force: true });

  // Read back BOTH facts Eden just wrote. OpenClaw's runtime predicate accepts
  // either one, but a repair succeeds only when the redundant marker AND file
  // removal invariants both landed on disk.
  try {
    await assertBootstrapSuppressionInvariants(wsDir);
  } catch (err) {
    regressed.push(`${openclawId} (${(err as Error).message})`);
  }
  await assertWorkspacePersonaDoctrine(wsDir);
  fixed++;
}
if (regressed.length > 0) {
  console.error(
    `FAILED: ${regressed.length} workspace(s) still resolve to bootstrap-pending ` +
      `(would run the blank-slate ritual on next load): ${regressed.join(', ')}`,
  );
  await pg.end();
  process.exit(1);
}
console.log(
  `repaired ${fixed} ${allRegistered ? 'registered' : 'pilot'} workspaces on disk ` +
    `(all verified bootstrap-complete and persona-doctrine compliant). ` +
    `Now restart the gateway: docker restart eden3-openclaw`,
);
await pg.end();
