import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LocalMediaStore, credit, getBalance } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import type { SessionEvent } from '@eden3/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MediaPipeline,
  attachmentKindForMime,
  mediaDebitIdempotencyKey,
  mimeForPath,
  pricedActionForTool,
} from '../src/services/media-pipeline';

loadRootEnv();

/**
 * MediaPipeline tests against live Postgres (localhost:5433), a temp-dir
 * LocalMediaStore, and fake (unique-content) media files. Fixture rows are
 * created uniquely per run and hard-deleted afterwards.
 */

const marker = `mediatest_${randomUUID().slice(0, 8)}`;
const mediaDir = mkdtempSync(path.join(tmpdir(), 'eden3-media-store-'));
const srcDir = mkdtempSync(path.join(tmpdir(), 'eden3-media-src-'));

let userId = '';
let agentId = '';
let brokeUserId = '';
let sessionId = '';
let brokeSessionId = '';

const events: Array<{ sessionId: string; event: SessionEvent }> = [];
const bus = {
  publish(sid: string, event: SessionEvent): number {
    events.push({ sessionId: sid, event });
    return 1;
  },
};

const pipeline = new MediaPipeline({
  store: new LocalMediaStore({ mediaDir, baseUrl: 'http://media.test/media' }),
  bus,
});

/** Minimal parseable PNG header (probeImageSize reads w/h) + unique tail. */
function fakePngFile(name: string, width = 3, height = 2): string {
  const unique = Buffer.from(randomUUID());
  const buf = Buffer.alloc(24 + unique.length);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  unique.copy(buf, 24);
  const filePath = path.join(srcDir, name);
  writeFileSync(filePath, buf);
  return filePath;
}

beforeAll(async () => {
  const accounts = await pg<{ id: string }[]>`
    insert into accounts (type, username) values
      ('user',  ${`${marker}_user`}),
      ('agent', ${`${marker}_agent`}),
      ('user',  ${`${marker}_broke`})
    returning id
  `;
  userId = accounts[0]!.id;
  agentId = accounts[1]!.id;
  brokeUserId = accounts[2]!.id;

  const sessions = await pg<{ id: string }[]>`
    insert into sessions (owner_id, title) values
      (${userId}, ${`${marker} session`}),
      (${brokeUserId}, ${`${marker} broke session`})
    returning id
  `;
  sessionId = sessions[0]!.id;
  brokeSessionId = sessions[1]!.id;

  await credit({ accountId: userId, amount: 20, type: 'credit:test' });
});

afterAll(async () => {
  await pg`delete from media_assets where session_id in (${sessionId}, ${brokeSessionId})
           or creation_id in (select id from creations where user_id in (${userId}, ${brokeUserId}))`;
  await pg`delete from messages where session_id in (${sessionId}, ${brokeSessionId})`;
  await pg`delete from creations where user_id in (${userId}, ${brokeUserId}) or agent_id = ${agentId}`;
  await pg`delete from sessions where id in (${sessionId}, ${brokeSessionId})`;
  await pg`delete from manna_transactions where manna_account_id in
           (select id from manna_accounts where account_id in (${userId}, ${agentId}, ${brokeUserId}))`;
  await pg`delete from manna_accounts where account_id in (${userId}, ${agentId}, ${brokeUserId})`;
  await pg`delete from accounts where username like ${`${marker}%`}`;
  await pg.end({ timeout: 5 });
});

describe('pure helpers', () => {
  it('maps extensions to mimes and mimes to kinds', () => {
    expect(mimeForPath('/x/tool-image-generation/a.jpg')).toBe('image/jpeg');
    expect(mimeForPath('/x/a.mp4')).toBe('video/mp4');
    expect(mimeForPath('/x/a.unknownext')).toBe('application/octet-stream');
    expect(attachmentKindForMime('image/png')).toBe('image');
    expect(attachmentKindForMime('video/mp4')).toBe('video');
    expect(attachmentKindForMime('audio/mpeg')).toBe('audio');
    expect(attachmentKindForMime('application/pdf')).toBe('file');
  });

  it('prices by tool first, then conservative kind fallback', () => {
    expect(pricedActionForTool('image_generate', 'image')).toBe('image');
    expect(pricedActionForTool('music_generate', 'audio')).toBe('music');
    expect(pricedActionForTool(null, 'audio')).toBe('tts'); // cheapest audio action
    expect(pricedActionForTool(null, 'file')).toBeNull();
    expect(pricedActionForTool('tts', 'audio')).toBe('tts');
  });
});

describe('MediaPipeline.ingestFile (live postgres)', () => {
  it('in-chat ingest: asset + creation + message + debit + events', async () => {
    const file = fakePngFile('chat.png');
    const before = await getBalance(userId);

    const result = await pipeline.ingestFile(file, {
      sessionId,
      agentAccountId: agentId,
      tool: 'image_generate',
    });

    expect(result.deduped).toBe(false);
    expect(result.mime).toBe('image/png');
    expect(result.kind).toBe('image');
    expect(result.url).toBe(`http://media.test/media/${result.sha256}.png`);

    // media_assets row
    expect(result.asset.sha256).toBe(result.sha256);
    expect(result.asset.sessionId).toBe(sessionId);
    expect(result.asset.width).toBe(3);
    expect(result.asset.height).toBe(2);

    // creations row — user = session owner, agent = generating agent
    expect(result.creation).not.toBeNull();
    expect(result.creation!.userId).toBe(userId);
    expect(result.creation!.agentId).toBe(agentId);
    expect(result.creation!.tool).toBe('image_generate');
    expect(result.creation!.url).toBe(result.url);

    // assistant message with the attachment payload
    expect(result.message).not.toBeNull();
    expect(result.message!.role).toBe('assistant');
    expect(result.message!.senderId).toBe(agentId);
    const attachments = result.message!.attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      url: result.url,
      mime: 'image/png',
      kind: 'image',
      creationId: result.creation!.id,
      width: 3,
      height: 2,
    });

    // session counters bumped
    const [session] = await pg<{ messageCount: number }[]>`
      select message_count as "messageCount" from sessions where id = ${sessionId}`;
    expect(session!.messageCount).toBe(1);

    // manna: 5 debited from the session owner with the sha+session key
    expect(result.billedAccountId).toBe(userId);
    expect(result.debitError).toBeNull();
    expect(result.debit?.balance.total).toBe(before.total - 5);
    const [tx] = await pg<{ amount: string; type: string }[]>`
      select amount, type from manna_transactions
      where idempotency_key = ${mediaDebitIdempotencyKey(result.sha256, sessionId)}`;
    expect(tx).toMatchObject({ amount: '-5.0000', type: 'spend:image' });

    // events published on the session channel
    const types = events.filter((e) => e.sessionId === sessionId).map((e) => e.event.type);
    expect(types).toContain('media.attached');
    expect(types).toContain('manna.updated');
  });

  it('re-ingesting the same file into the same session is a no-op', async () => {
    const file = fakePngFile('dedupe.png');
    const first = await pipeline.ingestFile(file, {
      sessionId,
      agentAccountId: agentId,
      tool: 'image_generate',
    });
    const balanceAfterFirst = await getBalance(userId);

    const second = await pipeline.ingestFile(file, {
      sessionId,
      agentAccountId: agentId,
      tool: 'image_generate',
    });

    expect(second.deduped).toBe(true);
    expect(second.creation?.id).toBe(first.creation!.id);
    expect(second.message).toBeNull(); // no duplicate message row
    expect((await getBalance(userId)).total).toBe(balanceAfterFirst.total); // no double charge

    const [countRow] = await pg<{ count: string }[]>`
      select count(*) from media_assets where sha256 = ${first.sha256}`;
    expect(Number(countRow!.count)).toBe(1);
  });

  it('concurrent double-ingest of the same NEW file creates exactly one creation (W2 #7)', async () => {
    const file = fakePngFile('concurrent.png');
    const before = await getBalance(userId);

    // Two ingests of the SAME brand-new file race into ingestFile at once. The
    // sha256 UNIQUE claim must serialize them so only ONE creation/message/
    // debit lands; the loser short-circuits as deduped.
    const [a, b] = await Promise.all([
      pipeline.ingestFile(file, { sessionId, agentAccountId: agentId, tool: 'image_generate' }),
      pipeline.ingestFile(file, { sessionId, agentAccountId: agentId, tool: 'image_generate' }),
    ]);

    // Same sha, same single creation id surfaced to both callers.
    expect(a.sha256).toBe(b.sha256);
    expect(a.creation?.id).toBeDefined();
    expect(b.creation?.id).toBe(a.creation?.id);
    // Exactly one of the two did the writing; the other reports deduped.
    expect([a.deduped, b.deduped].filter(Boolean)).toHaveLength(1);

    // Exactly one media_assets row and one creation row for this content.
    const [assetCount] = await pg<{ count: string }[]>`
      select count(*) from media_assets where sha256 = ${a.sha256}`;
    expect(Number(assetCount!.count)).toBe(1);
    const [creationCount] = await pg<{ count: string }[]>`
      select count(*) from creations where id = ${a.creation!.id}`;
    expect(Number(creationCount!.count)).toBe(1);

    // Exactly one assistant message row carries this creation as an attachment.
    const [msgCount] = await pg<{ count: string }[]>`
      select count(*) from messages
      where session_id = ${sessionId}
        and attachments @> ${JSON.stringify([{ creationId: a.creation!.id }])}::jsonb`;
    expect(Number(msgCount!.count)).toBe(1);

    // Charged exactly once (idempotent media debit key).
    expect((await getBalance(userId)).total).toBe(before.total - 5);
    const [debitCount] = await pg<{ count: string }[]>`
      select count(*) from manna_transactions
      where idempotency_key = ${mediaDebitIdempotencyKey(a.sha256, sessionId)}`;
    expect(Number(debitCount!.count)).toBe(1);
  });

  it('attach mode appends to an existing message and derives the agent from it', async () => {
    const file = fakePngFile('attach.png');
    const [row] = await pg<{ id: string }[]>`
      insert into messages (session_id, sender_id, role, content)
      values (${sessionId}, ${agentId}, 'assistant', 'Done! MEDIA:/home/node/.openclaw/media/x.png')
      returning id
    `;
    const messageId = row!.id;

    const result = await pipeline.ingestFile(file, {
      sessionId,
      messageId,
      tool: 'image_generate',
    });

    expect(result.message!.id).toBe(messageId); // attached, not inserted
    expect(result.message!.content).toContain('Done!');
    const attachments = result.message!.attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.creationId).toBe(result.creation!.id);
    // agent taken from the carrying message's sender
    expect(result.creation!.agentId).toBe(agentId);

    const [countRow] = await pg<{ count: string }[]>`
      select count(*) from messages where session_id = ${sessionId} and id = ${messageId}`;
    expect(Number(countRow!.count)).toBe(1);
  });

  it('parks an uncorrelated file, then completes it on late correlation', async () => {
    const file = fakePngFile('parked.png');

    const parked = await pipeline.ingestFile(file, { tool: 'image_generate' });
    expect(parked.creation).toBeNull();
    expect(parked.message).toBeNull();
    expect(parked.asset.sessionId).toBeNull();
    expect(parked.debit).toBeNull();

    const correlated = await pipeline.ingestFile(file, {
      sessionId,
      agentAccountId: agentId,
      tool: 'image_generate',
    });
    expect(correlated.deduped).toBe(false);
    expect(correlated.creation).not.toBeNull();
    expect(correlated.message).not.toBeNull();
    // the single sha row got its correlation columns filled in
    expect(correlated.asset.id).toBe(parked.asset.id);
    expect(correlated.asset.sessionId).toBe(sessionId);
    expect(correlated.asset.creationId).toBe(correlated.creation!.id);
  });

  it('keeps the artifact when the owner cannot pay (debitError, no negative balance)', async () => {
    const file = fakePngFile('broke.png');
    const result = await pipeline.ingestFile(file, {
      sessionId: brokeSessionId,
      agentAccountId: agentId,
      tool: 'image_generate',
    });
    expect(result.creation).not.toBeNull();
    expect(result.message).not.toBeNull();
    expect(result.debit).toBeNull();
    expect(result.debitError).toBe('insufficient_manna');
    expect((await getBalance(brokeUserId)).total).toBe(0);
  });

  it('studio-style ingest (userId, no session): creation only, no message, no debit', async () => {
    const file = fakePngFile('studio.png');
    const before = await getBalance(userId);
    const result = await pipeline.ingestFile(file, {
      userId,
      tool: 'image_generate',
      args: { prompt: 'test' },
    });
    expect(result.creation).not.toBeNull();
    expect(result.creation!.userId).toBe(userId);
    expect(result.creation!.agentId).toBeNull();
    expect(result.creation!.args).toEqual({ prompt: 'test' });
    expect(result.message).toBeNull();
    expect(result.debit).toBeNull();
    expect((await getBalance(userId)).total).toBe(before.total);
  });
});
