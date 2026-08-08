import type {
  PublicSessionShareDto,
  PublicSessionSnapshotDto,
  SessionShareSummaryDto,
} from '@eden3/shared';
import { describe, expect, it } from 'vitest';

import {
  hashSessionShareToken,
  SessionShareService,
  type CreateSessionShareCommand,
  type CreateSessionShareResult,
  type RevokeSessionShareResult,
  type SessionShareListResult,
  type SessionShareRepository,
} from '../src/services/session-shares';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const OWNER_ID = '00000000-0000-4000-8000-000000000002';
const MEMBER_ID = '00000000-0000-4000-8000-000000000003';
const STRANGER_ID = '00000000-0000-4000-8000-000000000004';
const MESSAGE_ONE = '00000000-0000-4000-8000-000000000011';
const MESSAGE_TWO = '00000000-0000-4000-8000-000000000012';
const MESSAGE_THREE = '00000000-0000-4000-8000-000000000013';

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryShareRepository implements SessionShareRepository {
  readonly members = new Set([OWNER_ID, MEMBER_ID]);
  readonly tokenHashes = new Set<string>();
  current: PublicSessionSnapshotDto = {
    sessionTitle: 'Launch notes',
    agents: [{ username: 'ada', name: 'Ada', userImage: null }],
    messages: [
      {
        id: MESSAGE_ONE,
        role: 'user',
        name: null,
        content: 'Original question',
        attachments: [
          {
            url: 'https://cdn.example.test/reference.png',
            mime: 'image/png',
            width: 640,
            height: 480,
          },
        ],
        createdAt: '2026-08-08T10:00:00.000Z',
      },
      {
        id: MESSAGE_TWO,
        role: 'assistant',
        name: 'Ada',
        content: 'Original answer',
        attachments: [],
        createdAt: '2026-08-08T10:00:01.000Z',
      },
    ],
    boundaryMessageId: MESSAGE_TWO,
    capturedAt: '2026-08-08T10:00:02.000Z',
  };
  private readonly shares = new Map<
    string,
    { summary: SessionShareSummaryDto; snapshot: PublicSessionSnapshotDto }
  >();

  async create(command: CreateSessionShareCommand): Promise<CreateSessionShareResult> {
    if (command.sessionId !== SESSION_ID) return { status: 'missing' };
    if (!this.members.has(command.actorId)) return { status: 'forbidden' };
    if (this.tokenHashes.has(command.tokenHash)) return { status: 'token_conflict' };
    const boundaryIndex = command.boundaryMessageId
      ? this.current.messages.findIndex((message) => message.id === command.boundaryMessageId)
      : this.current.messages.length - 1;
    if (command.boundaryMessageId && boundaryIndex < 0) return { status: 'invalid_boundary' };
    const id = `00000000-0000-4000-8000-${String(this.shares.size + 101).padStart(12, '0')}`;
    const snapshot = clone({
      ...this.current,
      messages: this.current.messages.slice(0, boundaryIndex + 1),
      boundaryMessageId: boundaryIndex < 0 ? null : this.current.messages[boundaryIndex]!.id,
      capturedAt: command.createdAt,
    });
    const summary: SessionShareSummaryDto = {
      id,
      sessionId: SESSION_ID,
      mode: command.mode,
      title: command.title,
      createdAt: command.createdAt,
      revokedAt: null,
    };
    this.tokenHashes.add(command.tokenHash);
    this.shares.set(command.tokenHash, { summary, snapshot });
    return { status: 'created', share: clone(summary) };
  }

  async list(sessionId: string, actorId: string): Promise<SessionShareListResult> {
    if (sessionId !== SESSION_ID) return { status: 'missing' };
    if (!this.members.has(actorId)) return { status: 'forbidden' };
    return {
      status: 'ok',
      items: [...this.shares.values()].map(({ summary }) => clone(summary)),
    };
  }

  async revoke(
    sessionId: string,
    shareId: string,
    actorId: string,
    revokedAt: string,
  ): Promise<RevokeSessionShareResult> {
    if (sessionId !== SESSION_ID) return { status: 'missing' };
    if (!this.members.has(actorId)) return { status: 'forbidden' };
    const row = [...this.shares.values()].find(({ summary }) => summary.id === shareId);
    if (!row) return { status: 'missing' };
    row.summary.revokedAt = revokedAt;
    return { status: 'revoked', share: clone(row.summary) };
  }

  async resolvePublic(tokenHash: string): Promise<PublicSessionShareDto | null> {
    const row = this.shares.get(tokenHash);
    if (!row || row.summary.revokedAt) return null;
    const snapshot = row.summary.mode === 'snapshot' ? row.snapshot : this.current;
    return {
      share: {
        id: row.summary.id,
        mode: row.summary.mode,
        title: row.summary.title,
        createdAt: row.summary.createdAt,
      },
      snapshot: clone(snapshot),
    };
  }
}

describe('session share service', () => {
  it('holds owner/member, snapshot/live, token secrecy, mutation, and revoke invariants', async () => {
    const repository = new MemoryShareRepository();
    const tokens = ['x'.repeat(43), 's'.repeat(43), 'l'.repeat(43)];
    let tick = 0;
    const service = new SessionShareService(repository, {
      token: () => tokens.shift()!,
      now: () => new Date(`2026-08-08T10:00:0${2 + tick++}.000Z`),
    });

    await expect(
      service.create(SESSION_ID, STRANGER_ID, { mode: 'snapshot' }),
    ).rejects.toMatchObject({ code: 'share_forbidden' });

    const snapshot = await service.create(SESSION_ID, OWNER_ID, {
      mode: 'snapshot',
      title: 'Fixed launch excerpt',
      boundaryMessageId: MESSAGE_ONE,
    });
    const live = await service.create(SESSION_ID, MEMBER_ID, { mode: 'live' });
    expect(snapshot.token).toHaveLength(43);
    expect(repository.tokenHashes.has(snapshot.token)).toBe(false);
    expect(repository.tokenHashes.has(hashSessionShareToken(snapshot.token))).toBe(true);

    repository.current.messages[0]!.content = 'Mutated after sharing';
    repository.current.messages.push({
      id: MESSAGE_THREE,
      role: 'assistant',
      name: 'Ada',
      content: 'Live append',
      attachments: [],
      createdAt: '2026-08-08T10:00:04.000Z',
    });
    repository.current.boundaryMessageId = MESSAGE_THREE;

    const fixedPublic = await service.resolvePublic(snapshot.token);
    expect(fixedPublic?.snapshot.messages).toHaveLength(1);
    expect(fixedPublic?.snapshot.messages[0]).toMatchObject({
      id: MESSAGE_ONE,
      content: 'Original question',
      attachments: [{ url: 'https://cdn.example.test/reference.png' }],
    });
    expect((await service.resolvePublic(live.token))?.snapshot.messages.at(-1)?.content).toBe(
      'Live append',
    );

    await expect(service.list(SESSION_ID, STRANGER_ID)).rejects.toMatchObject({
      code: 'share_forbidden',
    });
    await expect(
      service.revoke(SESSION_ID, live.share.id, STRANGER_ID),
    ).rejects.toMatchObject({ code: 'share_forbidden' });
    await service.revoke(SESSION_ID, live.share.id, OWNER_ID);
    expect(await service.resolvePublic(live.token)).toBeNull();
    expect((await service.list(SESSION_ID, OWNER_ID)).items).toContainEqual(
      expect.objectContaining({ id: live.share.id, revokedAt: '2026-08-08T10:00:06.000Z' }),
    );
  });
});
