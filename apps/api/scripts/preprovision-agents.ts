/**
 * One-time serial pre-provisioner: walk every `pending` agent and run the
 * exact lazy-provision recipe the chat route uses (provision → default
 * skills → tool groups → status ready), so migrated agents are chattable
 * without the on-first-chat warm-up.
 *
 * Serial by design — provisioning rewrites openclaw.json per agent, and this
 * is a run-once batch where wall-clock doesn't matter. Idempotent/resumable:
 * only `pending` rows are touched, so re-running continues where it stopped.
 * Skips memory distillation entirely (a separate, owner-triggered concern).
 *
 *   DATABASE_URL=… tsx scripts/preprovision-agents.ts [--limit N] [--dry-run]
 *
 * Writes a timing/RSS proof artifact to var/acceptance/.
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { and, eq, isNotNull } from 'drizzle-orm';

import { accounts, agents, db, pg } from '@eden3/db';
import { DEFAULT_AGENT_THINKING_LEVEL, DEFAULT_AGENT_TOOL_GROUPS } from '@eden3/shared';

import { DEFAULT_AGENT_MODEL, GatewayGlue } from '../src/gateway-glue';
import { installDefaultAgentSkills } from '../src/services/agent-skills';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

function gatewayRssMb(): number | null {
  try {
    const out = execSync('docker stats --no-stream --format "{{.MemUsage}}" eden3-openclaw', {
      encoding: 'utf8',
      timeout: 20000,
    }).trim();
    const m = out.match(/([\d.]+)\s*(Ki|Mi|Gi)B/);
    if (!m) return null;
    const v = Number(m[1]);
    return m[2] === 'Gi' ? v * 1024 : m[2] === 'Ki' ? v / 1024 : v;
  } catch {
    return null;
  }
}

function configBytes(): number | null {
  try {
    const p = path.join(REPO_ROOT, 'infra', 'openclaw', 'data', 'openclaw.json');
    return execSync(`wc -c < ${JSON.stringify(p)}`, { encoding: 'utf8' }).trim()
      ? Number(execSync(`wc -c < ${JSON.stringify(p)}`, { encoding: 'utf8' }).trim())
      : null;
  } catch {
    return null;
  }
}

const rows = await db
  .select({
    accountId: agents.accountId,
    username: accounts.username,
    openclawId: agents.openclawId,
    name: agents.name,
    description: agents.description,
    persona: agents.persona,
    greeting: agents.greeting,
    voice: agents.voice,
    thinkingLevel: agents.thinkingLevel,
    model: agents.model,
    toolGroups: agents.toolGroups,
  })
  .from(agents)
  .innerJoin(accounts, eq(accounts.id, agents.accountId))
  .where(and(eq(agents.provisionStatus, 'pending'), isNotNull(agents.openclawId)))
  .orderBy(accounts.username);

console.log(`${rows.length} pending agents${dryRun ? ' (dry run)' : ''}`);
const glue = new GatewayGlue();
const startedAt = new Date().toISOString();
const rssBefore = gatewayRssMb();
const configBefore = configBytes();
const timings: number[] = [];
const failures: Array<{ openclawId: string; error: string }> = [];
let done = 0;

for (const row of rows.slice(0, limit)) {
  const openclawId = row.openclawId as string;
  if (dryRun) {
    console.log(`would provision ${row.username} → ${openclawId}`);
    continue;
  }
  const t0 = Date.now();
  try {
    await db
      .update(agents)
      .set({ provisionStatus: 'provisioning' })
      .where(eq(agents.accountId, row.accountId));
    const result = await glue.provisioner.provisionAgent({
      openclawId,
      name: row.name ?? row.username,
      username: row.username,
      description: row.description ?? '',
      persona: row.persona ?? '',
      greeting: row.greeting ?? '',
      voice: row.voice ?? '',
      thinkingLevel: row.thinkingLevel ?? DEFAULT_AGENT_THINKING_LEVEL,
      model: row.model ?? DEFAULT_AGENT_MODEL,
    });
    await installDefaultAgentSkills({
      agentId: row.accountId,
      openclawId,
      workspacePath: result.hostWorkspaceDir,
      skillSync: glue.skillSync,
    });
    await glue.toolSync.syncAgentToolGroups({
      openclawId,
      toolGroups: (row.toolGroups as string[] | null) ?? DEFAULT_AGENT_TOOL_GROUPS,
    });
    await db
      .update(agents)
      .set({
        workspacePath: result.hostWorkspaceDir,
        provisionStatus: 'ready',
        provisionedAt: new Date(),
      })
      .where(eq(agents.accountId, row.accountId));
    const ms = Date.now() - t0;
    timings.push(ms);
    done += 1;
    console.log(`[${done}/${Math.min(rows.length, limit)}] ${openclawId} ready in ${ms}ms`);
  } catch (err) {
    await db
      .update(agents)
      .set({ provisionStatus: 'failed' })
      .where(eq(agents.accountId, row.accountId));
    const msg = err instanceof Error ? err.message : String(err);
    failures.push({ openclawId, error: msg.slice(0, 300) });
    console.error(`FAILED ${openclawId}: ${msg.slice(0, 200)}`);
  }
}

if (!dryRun && timings.length > 0) {
  const sorted = [...timings].sort((a, b) => a - b);
  const stamp = startedAt.replace(/[:.]/g, '-');
  const report = {
    kind: 'eden3-preprovision-batch',
    startedAt,
    finishedAt: new Date().toISOString(),
    database: (process.env.DATABASE_URL ?? '').replace(/\/\/.*@/, '//<creds>@'),
    provisioned: done,
    failed: failures,
    timingMs: {
      total: timings.reduce((a, b) => a + b, 0),
      mean: Math.round(timings.reduce((a, b) => a + b, 0) / timings.length),
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      max: sorted[sorted.length - 1],
    },
    gatewayRssMb: { before: rssBefore, after: gatewayRssMb() },
    openclawConfigBytes: { before: configBefore, after: configBytes() },
  };
  const out = path.join(REPO_ROOT, 'var', 'acceptance', `preprovision-${stamp}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('\nreport:', out);
  console.log(JSON.stringify(report.timingMs), '| rss', JSON.stringify(report.gatewayRssMb), '| config', JSON.stringify(report.openclawConfigBytes));
}
await pg.end();
process.exit(failures.length > 0 ? 1 : 0);
