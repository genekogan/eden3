/**
 * Provision migrated pilot agents into the OpenClaw gateway.
 * Reads agents flagged is_pilot (or a --username filter) from Postgres, renders
 * their workspace from persona/greeting/description, registers them via the CLI,
 * and flips provision_status. Idempotent. Memory seeding is done separately by
 * the distillation pipeline (this only lays down the workspace + registration).
 *
 * Usage:
 *   tsx scripts/provision-pilots.ts                 # all is_pilot agents
 *   tsx scripts/provision-pilots.ts --username eve  # one agent
 *   tsx scripts/provision-pilots.ts --limit 5       # first N
 */
import { AgentProvisioner } from '@eden3/gateway';
import { pg } from '@eden3/db';
import { loadEnv } from '@eden3/core';

const env = loadEnv();
const args = process.argv.slice(2);
const only = args.includes('--username') ? args[args.indexOf('--username') + 1] : null;
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : null;
// Bulk pilots use haiku for cost; override per-agent later if desired.
const MODEL = args.includes('--model') ? args[args.indexOf('--model') + 1]! : 'anthropic/claude-haiku-4-5';
// Persona/greeting/description are authored in Postgres (the migration source of
// truth), so re-render them over the workspace by default — this also repairs
// agents whose workspace was clobbered by OpenClaw's `agents add` default seed.
// Pass --no-force to preserve any in-workspace hand-edits instead.
const FORCE = !args.includes('--no-force');

interface AgentRow {
  accountId: string;
  username: string;
  name: string | null;
  description: string | null;
  persona: string | null;
  greeting: string | null;
  openclawId: string | null;
}

const rows = await pg<AgentRow[]>`
  select ag.account_id as "accountId", a.username, ag.name, ag.description,
         ag.persona, ag.greeting, ag.openclaw_id as "openclawId"
  from agents ag join accounts a on a.id = ag.account_id
  where a.deleted = false
    ${only ? pg`and a.username = ${only}` : pg`and ag.is_pilot = true`}
  order by a.username asc
  ${limit ? pg`limit ${limit}` : pg``}
`;

if (rows.length === 0) {
  console.error('no matching agents');
  process.exit(1);
}

const provisioner = new AgentProvisioner({
  gateway: { baseUrl: env.OPENCLAW_BASE_URL, token: env.OPENCLAW_GATEWAY_TOKEN },
});

let ok = 0;
let failed = 0;
for (const r of rows) {
  const openclawId = r.openclawId ?? r.username.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  try {
    const res = await provisioner.provisionAgent(
      {
        openclawId,
        name: r.name ?? r.username,
        username: r.username,
        description: r.description ?? '',
        persona: r.persona ?? `You are ${r.name ?? r.username}, an agent on Eden.`,
        greeting: r.greeting ?? '',
        model: MODEL,
      },
      { force: FORCE },
    );
    await pg`
      update agents set provision_status = 'ready', provisioned_at = now(),
             openclaw_id = ${openclawId}, workspace_path = ${res.hostWorkspaceDir}
      where account_id = ${r.accountId}
    `;
    ok++;
    console.log(`✓ ${r.username} (${openclawId}) — ${res.registration}, ${res.filesWritten.length} files`);
  } catch (err) {
    failed++;
    await pg`update agents set provision_status = 'failed' where account_id = ${r.accountId}`;
    console.error(`✗ ${r.username}: ${(err as Error).message}`);
  }
}
console.log(`\ndone: ${ok} provisioned, ${failed} failed of ${rows.length}`);
await pg.end();
process.exit(failed > 0 ? 1 : 0);
