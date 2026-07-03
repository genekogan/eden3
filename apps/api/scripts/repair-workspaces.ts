/**
 * Disk-only workspace repair: render each provisioned pilot's workspace from
 * the templates + DB persona WITHOUT any gateway calls (no agent load → no
 * seed-clobber), write the setupCompletedAt marker, and remove any seeded
 * BOOTSTRAP.md. Run this, then restart the gateway once so already-resident
 * agents drop their cached default persona and reload from the corrected files.
 *
 *   tsx scripts/repair-workspaces.ts        # all provisioned pilots
 *   tsx scripts/repair-workspaces.ts --all-registered   # every workspace-* dir
 */
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pg } from '@eden3/db';
import { workspaceBootstrapStatus } from '@eden3/gateway';

const DATA_DIR = process.env.OPENCLAW_DATA_DIR ?? path.resolve('infra/openclaw/data');
const TEMPLATES_DIR = fileURLToPath(new URL('../../../packages/gateway/workspace-templates/', import.meta.url));
const CONTENT_FILES = ['SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'TOOLS.md', 'USER.md', 'MEMORY.md'];

function render(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{([A-Z_]+)\}\}/g, (_m, k: string) => vars[k] ?? '');
}

const rows = await pg<{
  openclawId: string; username: string; name: string | null; description: string | null;
  persona: string | null; greeting: string | null;
}[]>`
  select ag.openclaw_id as "openclawId", a.username, ag.name, ag.description, ag.persona, ag.greeting
  from agents ag join accounts a on a.id = ag.account_id
  where ag.provision_status = 'provisioned' and ag.openclaw_id is not null and ag.is_pilot
  order by a.username asc
`;

const templates = new Map<string, string>();
for (const f of CONTENT_FILES) {
  templates.set(f, await readFile(path.join(TEMPLATES_DIR, f), 'utf8'));
}

let fixed = 0;
const regressed: string[] = [];
for (const r of rows) {
  const wsDir = path.join(DATA_DIR, `workspace-${r.openclawId}`);
  await mkdir(path.join(wsDir, 'memory', 'users'), { recursive: true });
  const vars: Record<string, string> = {
    NAME: r.name ?? r.username,
    USERNAME: r.username,
    DESCRIPTION: r.description ?? '',
    PERSONA: r.persona ?? `You are ${r.name ?? r.username}, an agent on Eden.`,
    GREETING: r.greeting ?? '',
    MEMORY_SEED: '',
    PROVISIONED_AT: new Date().toISOString(),
  };
  // Preserve an already-distilled MEMORY.md (don't overwrite real memory with the stub).
  const existingMemory = await readFile(path.join(wsDir, 'MEMORY.md'), 'utf8').catch(() => '');
  const memoryDistilled = existingMemory.includes('## Who I am') || existingMemory.includes('Distilled from');
  for (const f of CONTENT_FILES) {
    if (f === 'MEMORY.md' && memoryDistilled) continue;
    await writeFile(path.join(wsDir, f), render(templates.get(f)!, vars), 'utf8');
  }
  await writeFile(
    path.join(wsDir, 'openclaw-workspace-state.json'),
    JSON.stringify({ version: 1, setupCompletedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
  await rm(path.join(wsDir, 'BOOTSTRAP.md'), { force: true });

  // Verify the repair actually yields the "complete" state under OpenClaw's own
  // per-turn predicate — this is what a `docker restart` re-evaluates, so a
  // "complete" here is the restart-survival guarantee. Fail loudly on any
  // workspace that would still run the blank-slate ritual.
  const status = await workspaceBootstrapStatus(wsDir);
  if (status !== 'complete') {
    regressed.push(`${r.openclawId} (${status})`);
  }
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
  `repaired ${fixed} workspaces on disk (all verified bootstrap-complete). ` +
    `Now restart the gateway: docker restart eden3-openclaw`,
);
await pg.end();
