import { describe, expect, it } from 'vitest';

import {
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
  agentDto,
  chatRequestDto,
  chatResponseDto,
  collectionDto,
  creationDto,
  cronScheduleDto,
  decodeFeedCursor,
  encodeFeedCursor,
  feedPageDto,
  feedQuerySchema,
  mannaBalanceDto,
  mannaTransactionDto,
  messageDto,
  paginated,
  sessionDto,
  triggerDto,
  tryDecodeFeedCursor,
  type FeedCursor,
} from '../src/dto';

const uuid = (n: string) => `019797a8-2b2e-7bbb-8f2a-${n.repeat(12)}`;
const now = '2026-07-02T12:34:56.789Z';
const mongoHex = '65a1b2c3d4e5f6a7b8c9d0e1';

describe('resource DTOs', () => {
  it('parses an agent', () => {
    const agent = {
      id: uuid('1'),
      externalId: mongoHex,
      username: 'abraham',
      name: 'Abraham',
      description: 'An autonomous artificial artist',
      persona: 'You are Abraham…',
      greeting: 'Hello.',
      voice: null,
      model: 'anthropic/claude-haiku-4-5',
      thinkingLevel: 'balanced',
      toolGroups: ['group:runtime', 'group:fs'],
      userImage: 'https://cdn.example.com/abraham.png',
      public: true,
      ownerId: uuid('2'),
      isPilot: true,
      isSynthetic: false,
      provisionStatus: 'ready',
      createdAt: now,
      updatedAt: now,
    };
    expect(agentDto.parse(agent)).toEqual(agent);
    expect(
      agentDto.safeParse({ ...agent, provisionStatus: 'exploded' }).success,
    ).toBe(false);
    expect(agentDto.safeParse({ ...agent, toolGroups: ['group:openclaw'] }).success).toBe(false);
    expect(agentDto.safeParse({ ...agent, id: 'not-a-uuid' }).success).toBe(false);
    expect(agentDto.safeParse({ ...agent, createdAt: 'yesterday' }).success).toBe(false);
  });

  it('parses a session with members (native rows have null externalId)', () => {
    const session = {
      id: uuid('3'),
      externalId: null,
      ownerId: uuid('2'),
      title: 'chat with abraham',
      status: null,
      sessionType: null,
      platform: 'app',
      agentIds: [uuid('1')],
      userIds: [uuid('2')],
      lastMessageAt: now,
      messageCount: 12,
      createdAt: now,
      updatedAt: now,
    };
    expect(sessionDto.parse(session)).toEqual(session);
    expect(sessionDto.safeParse({ ...session, messageCount: -1 }).success).toBe(false);
  });

  it('parses messages incl. migrated loose roles and attachments', () => {
    const message = {
      id: uuid('4'),
      externalId: mongoHex,
      sessionId: uuid('3'),
      senderId: uuid('1'),
      role: 'assistant',
      content: 'Here you go.',
      attachments: [
        { url: '/media/ab12.png', mime: 'image/png', creationId: uuid('5') },
        { url: 'https://cdn.example.com/old.jpg' },
      ],
      toolCalls: [{ name: 'image_generate', args: { prompt: 'a rose' } }],
      reactions: { '👍': [mongoHex] },
      replyToExternalId: null,
      createdAt: now,
    };
    expect(messageDto.parse(message)).toMatchObject({ role: 'assistant' });
    // migrated data may carry non-canonical roles — contract stays loose
    expect(messageDto.safeParse({ ...message, role: 'eden' }).success).toBe(true);
    expect(messageDto.safeParse({ ...message, attachments: [{ mime: 'x' }] }).success).toBe(false);
  });

  it('parses creations and collections', () => {
    const creation = {
      id: uuid('5'),
      externalId: mongoHex,
      userId: uuid('2'),
      agentId: uuid('1'),
      tool: 'image_generate',
      filename: 'rose.png',
      url: 'https://dxxxxx.cloudfront.net/rose.png',
      thumbnailUrl: null,
      mediaAttributes: { width: 1024, height: 1024 },
      likeCount: 3,
      public: true,
      createdAt: now,
      updatedAt: now,
    };
    expect(creationDto.parse(creation)).toEqual(creation);

    const collection = {
      id: uuid('6'),
      externalId: null,
      userId: uuid('2'),
      name: 'roses',
      description: null,
      public: false,
      creationCount: 1,
      createdAt: now,
      updatedAt: now,
    };
    expect(collectionDto.parse(collection)).toEqual(collection);
  });

  it('parses manna balance + transactions as numbers', () => {
    const balance = {
      accountId: uuid('2'),
      balance: 42.5,
      subscriptionBalance: 0,
      updatedAt: now,
    };
    expect(mannaBalanceDto.parse(balance)).toEqual(balance);
    expect(mannaBalanceDto.safeParse({ ...balance, balance: '42.5' }).success).toBe(false);

    const tx = {
      id: uuid('7'),
      mannaAccountId: uuid('8'),
      amount: -5,
      type: 'media_debit',
      taskExternalId: null,
      refundsTransactionId: null,
      createdAt: now,
    };
    expect(mannaTransactionDto.parse(tx)).toEqual(tx);
  });

  it('parses triggers with the eden1 snake_case schedule dict', () => {
    const schedule = { hour: 9, minute: '30', day_of_week: 'mon-fri', timezone: 'UTC' };
    expect(cronScheduleDto.parse(schedule)).toEqual(schedule);
    // One-time shape: fire once at this instant.
    expect(cronScheduleDto.parse({ at: now })).toEqual({ at: now });

    const trigger = {
      id: uuid('9'),
      externalId: mongoHex,
      userId: uuid('2'),
      agentId: uuid('1'),
      name: 'daily rose',
      prompt: 'paint a rose',
      schedule,
      status: 'active',
      lastRunTime: now,
      nextScheduledRun: null,
      lastRunSessionId: uuid('4'),
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(triggerDto.parse(trigger)).toEqual(trigger);
    expect(triggerDto.safeParse({ ...trigger, schedule: null }).success).toBe(true);
    expect(triggerDto.safeParse({ ...trigger, lastRunSessionId: null }).success).toBe(true);
  });

  it('parses chat request/response', () => {
    expect(chatRequestDto.parse({ agentId: uuid('1'), content: 'hi' })).toEqual({
      agentId: uuid('1'),
      content: 'hi',
    });
    expect(chatRequestDto.safeParse({ agentId: uuid('1'), content: '' }).success).toBe(false);
    expect(
      chatResponseDto.parse({ sessionId: uuid('3'), turnId: uuid('4'), messageId: uuid('5') }),
    ).toBeTruthy();
  });
});

describe('feed pagination', () => {
  const cursor: FeedCursor = { createdAt: now, id: uuid('5') };

  it('cursor codec round-trips and is opaque/url-safe', () => {
    const encoded = encodeFeedCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(decodeFeedCursor(encoded)).toEqual(cursor);
    expect(tryDecodeFeedCursor(encoded)).toEqual(cursor);
  });

  it('rejects malformed cursors', () => {
    expect(tryDecodeFeedCursor('garbage!!!')).toBeNull();
    expect(tryDecodeFeedCursor('')).toBeNull();
    // valid base64url of invalid JSON / wrong shape
    expect(tryDecodeFeedCursor(Buffer.from('nope').toString('base64url'))).toBeNull();
    expect(
      tryDecodeFeedCursor(Buffer.from(JSON.stringify({ id: 'x' })).toString('base64url')),
    ).toBeNull();
    expect(() => decodeFeedCursor('garbage!!!')).toThrow(/cursor/i);
    expect(() => encodeFeedCursor({ createdAt: 'bad', id: 'bad' } as FeedCursor)).toThrow();
  });

  it('feedQuerySchema coerces limit and applies bounds/defaults', () => {
    expect(feedQuerySchema.parse({})).toEqual({ limit: FEED_DEFAULT_LIMIT });
    expect(feedQuerySchema.parse({ limit: '50', cursor: 'abc' })).toEqual({
      limit: 50,
      cursor: 'abc',
    });
    expect(feedQuerySchema.safeParse({ limit: FEED_MAX_LIMIT + 1 }).success).toBe(false);
    expect(feedQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('feedPageDto wraps creations with a nullable nextCursor', () => {
    const page = {
      items: [
        {
          id: uuid('5'),
          externalId: mongoHex,
          userId: null,
          agentId: uuid('1'),
          tool: 'image_generate',
          filename: null,
          url: 'https://cdn.example.com/x.png',
          thumbnailUrl: null,
          mediaAttributes: null,
          likeCount: 0,
          public: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
      nextCursor: encodeFeedCursor(cursor),
    };
    expect(feedPageDto.parse(page)).toEqual(page);
    expect(feedPageDto.parse({ items: [], nextCursor: null }).nextCursor).toBeNull();
  });

  it('paginated() builds pages around any item schema', () => {
    const page = paginated(mannaTransactionDto).parse({
      items: [
        {
          id: uuid('7'),
          mannaAccountId: uuid('8'),
          amount: 1,
          type: 'refund',
          taskExternalId: null,
          refundsTransactionId: uuid('9'),
          createdAt: now,
        },
      ],
      nextCursor: null,
    });
    expect(page.items).toHaveLength(1);
  });
});
