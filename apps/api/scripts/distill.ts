/**
 * Memory distillation pipeline for pilot agents (the Abraham pattern, cost-scaled
 * for a draft). For each agent: sample its migrated conversations from Postgres
 * (recency-weighted, token-capped), map each chunk to notes via headless
 * `claude -p` (haiku, operator subscription — NO API spend), reduce the notes to
 * a first-person MEMORY.md (+ per-collaborator notes for flagships), and install
 * into the agent's OpenClaw workspace. Resumable via the distill_state table.
 *
 * Usage:
 *   tsx scripts/distill.ts --username abraham
 *   tsx scripts/distill.ts --all               # all provisioned pilots
 *   tsx scripts/distill.ts --all --concurrency 2
 *   tsx scripts/distill.ts --username eve --force
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { pg } from '@eden3/db';
import { loadEnv } from '@eden3/core';

import { MAP_PROMPT, REDUCE_PROMPT, USERS_PROMPT } from './distill-prompts.js';

const exec = promisify(execFile);
const env = loadEnv();
const DATA_DIR = process.env.OPENCLAW_DATA_DIR ?? path.resolve('infra/openclaw/data');

const args = process.argv.slice(2);
const only = args.includes('--username') ? args[args.indexOf('--username') + 1]! : null;
const all = args.includes('--all');
const force = args.includes('--force');
const concurrency = args.includes('--concurrency') ? Number(args[args.indexOf('--concurrency') + 1]) : 1;

// Input budget: cap chars sampled per agent so eve (237k msgs) costs like the rest.
const MAX_CHARS = 90_000; // ~22k tokens of transcript per agent
const CHUNK_CHARS = 30_000; // → ~3 map chunks max
const FLAGSHIPS = new Set(['abraham', 'eve', 'solienne', 'chiba', 'verdelis', 'dungeon-master']);

const MAP_MODEL = 'claude-haiku-4-5';
const REDUCE_MODEL = 'claude-sonnet-4-6';

interface Pilot { openclawId: string; username: string; accountId: string; persona: string | null }

async function claudeP(prompt: string, input: string, model: string): Promise<string> {
  // headless one-shot. NOTE: `claude -p` has a ~3s stdin read timeout and races
  // execFile's stdin write ("no stdin data received in 3s, proceeding without it"),
  // silently dropping the content. So embed the content in the prompt arg instead
  // (map chunks are <=30k chars, reduce notes are small — well under ARG_MAX), and
  // close stdin explicitly.
  const full = `${prompt}\n\n---\nINPUT:\n${input}`;
  const { stdout } = await exec(
    'claude',
    ['-p', full, '--model', model],
    { input: '', maxBuffer: 64 * 1024 * 1024, timeout: 300_000, encoding: 'utf8' },
  );
  return stdout.trim();
}

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.slice(0, 3); // hard cap 3 chunks
}

async function sampleTranscripts(accountId: string): Promise<{ text: string; sessions: number; messages: number }> {
  // Recency-weighted: newest sessions first, take messages until MAX_CHARS.
  const sessions = await pg<{ id: string; title: string | null }[]>`
    select distinct s.id, s.title, s.last_message_at
    from sessions s join session_agents sa on sa.session_id = s.id
    where sa.agent_account_id = ${accountId} and s.deleted = false
    order by s.last_message_at desc nulls last
    limit 200
  `;
  const parts: string[] = [];
  let chars = 0;
  let usedSessions = 0;
  let usedMessages = 0;
  for (const s of sessions) {
    if (chars >= MAX_CHARS) break;
    const msgs = await pg<{ role: string; content: string | null; senderName: string | null }[]>`
      select m.role, m.content, a.username as "senderName"
      from messages m left join accounts a on a.id = m.sender_id
      where m.session_id = ${s.id} and m.content is not null and m.content <> ''
      order by m.created_at asc limit 60
    `;
    if (msgs.length === 0) continue;
    let block = `\n## Conversation: ${s.title ?? '(untitled)'}\n`;
    for (const m of msgs) {
      const who = m.role === 'assistant' ? 'AGENT' : `[${m.senderName ?? m.role}]`;
      const c = (m.content ?? '').slice(0, 800);
      block += `${who}: ${c}\n`;
    }
    parts.push(block);
    chars += block.length;
    usedSessions++;
    usedMessages += msgs.length;
  }
  return { text: parts.join('\n').slice(0, MAX_CHARS), sessions: usedSessions, messages: usedMessages };
}

async function distill(p: Pilot): Promise<void> {
  const wsDir = path.join(DATA_DIR, `workspace-${p.openclawId}`);
  const memDir = path.join(wsDir, 'memory');

  const existing = await pg<{ status: string }[]>`select status from distill_state where openclaw_id = ${p.openclawId}`;
  if (existing[0]?.status === 'done' && !force) {
    console.log(`• ${p.username}: already distilled (--force to redo)`);
    return;
  }
  await pg`insert into distill_state (openclaw_id, username, status) values (${p.openclawId}, ${p.username}, 'running')
           on conflict (openclaw_id) do update set status = 'running', updated_at = now(), error = null`;

  try {
    const { text, sessions, messages } = await sampleTranscripts(p.accountId);
    if (text.length < 200) {
      console.log(`• ${p.username}: too little content (${text.length} chars) — skipping`);
      await pg`update distill_state set status='skipped', sessions_sampled=${sessions}, messages_sampled=${messages}, updated_at=now() where openclaw_id=${p.openclawId}`;
      return;
    }
    const chunks = chunk(text, CHUNK_CHARS);
    // MAP
    const notes: string[] = [];
    for (const [i, ch] of chunks.entries()) {
      const n = await claudeP(MAP_PROMPT(p.username), ch, MAP_MODEL);
      notes.push(n);
      console.log(`  ${p.username}: mapped chunk ${i + 1}/${chunks.length} (${n.length} chars)`);
    }
    const allNotes = notes.join('\n');
    // REDUCE → MEMORY.md
    const reduceModel = FLAGSHIPS.has(p.username) ? 'claude-opus-4-6' : REDUCE_MODEL;
    const coverage = `from ${messages.toLocaleString()} messages across ${sessions} recent conversations (${new Date().toISOString().slice(0, 10)})`;
    const memory = await claudeP(REDUCE_PROMPT(p.username, p.persona ?? '', coverage), allNotes, reduceModel);

    await mkdir(memDir, { recursive: true });
    await writeFile(path.join(wsDir, 'MEMORY.md'), memory + '\n', 'utf8');

    // Per-collaborator notes for flagships
    if (FLAGSHIPS.has(p.username)) {
      const users = await claudeP(USERS_PROMPT(p.username), allNotes, REDUCE_MODEL);
      if (users.length > 40) {
        await mkdir(path.join(memDir, 'users'), { recursive: true });
        await writeFile(path.join(memDir, 'users', 'INDEX.md'), `# Collaborators — ${p.username}\n\n${users}\n`, 'utf8');
      }
    }

    await pg`update distill_state set status='done', sessions_sampled=${sessions}, messages_sampled=${messages},
             map_chunks=${chunks.length}, memory_chars=${memory.length}, model=${reduceModel}, updated_at=now()
             where openclaw_id=${p.openclawId}`;
    console.log(`✓ ${p.username}: MEMORY.md ${memory.length} chars (${reduceModel}), ${sessions} sessions / ${messages} msgs sampled`);
  } catch (err) {
    await pg`update distill_state set status='error', error=${String((err as Error).message).slice(0, 500)}, updated_at=now() where openclaw_id=${p.openclawId}`;
    console.error(`✗ ${p.username}: ${(err as Error).message}`);
  }
}

// ---- main ----
const pilots = await pg<Pilot[]>`
  select ag.openclaw_id as "openclawId", a.username, ag.account_id as "accountId", ag.persona
  from agents ag join accounts a on a.id = ag.account_id
  where ag.provision_status = 'provisioned'
    and ag.openclaw_id is not null
    ${only ? pg`and a.username = ${only}` : all ? pg`and ag.is_pilot = true` : pg`and false`}
  order by a.username asc
`;
if (pilots.length === 0) {
  console.error('no provisioned pilots match (provision first, or pass --username/--all)');
  process.exit(1);
}
console.log(`distilling ${pilots.length} agent(s), concurrency ${concurrency}\n`);

// simple concurrency pool
let idx = 0;
async function worker() {
  while (idx < pilots.length) {
    const p = pilots[idx++]!;
    await distill(p);
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

const summary = await pg<{ status: string; n: bigint }[]>`select status, count(*) as n from distill_state group by status order by status`;
console.log('\ndistill summary:', summary.map((r) => `${r.status}=${r.n}`).join(' '));
await pg.end();
