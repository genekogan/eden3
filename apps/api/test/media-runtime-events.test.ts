import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '@eden3/shared';
import {
  mediaAuthorizationFailureCode,
  publishChatMediaFailed,
  publishChatMediaPending,
} from '../src/routes/media-runtime';

const SESSION_ID = '6c1f5b7e-3d2a-4e8b-9f10-2a3b4c5d6e7f';

describe('media runtime UI lifecycle events', () => {
  it('classifies authorization failures without logging provider or account detail', () => {
    expect(
      mediaAuthorizationFailureCode(
        new Error('chat-media-authorization: unsupported image_generate argument quality'),
      ),
    ).toBe('unsupported_image_argument');
    expect(
      mediaAuthorizationFailureCode(
        new Error('chat-media-authorization: media action already pending for session'),
      ),
    ).toBe('media_already_pending');
    expect(
      mediaAuthorizationFailureCode(
        new Error('chat-media-authorization: session/agent binding unavailable'),
      ),
    ).toBe('session_agent_binding');
    expect(mediaAuthorizationFailureCode(new Error('database host detail'))).toBe('unknown');
  });

  it('publishes pending at provider admission and terminal failure safely', () => {
    const events: Array<{ sessionId: string; event: SessionEvent }> = [];
    const bus = {
      publish(sessionId: string, event: SessionEvent) {
        events.push({ sessionId, event });
        return 1;
      },
    };

    publishChatMediaPending(bus, {
      sessionId: SESSION_ID,
      tool: 'image_generate',
    });
    publishChatMediaFailed(
      bus,
      { sessionId: SESSION_ID, tool: 'image_generate' },
      'media_tool_failed',
    );

    expect(events).toEqual([
      {
        sessionId: SESSION_ID,
        event: {
          type: 'media.pending',
          sessionId: SESSION_ID,
          tool: 'image_generate',
        },
      },
      {
        sessionId: SESSION_ID,
        event: {
          type: 'media.failed',
          sessionId: SESSION_ID,
          tool: 'image_generate',
          code: 'media_tool_failed',
          message: 'Media generation failed before producing output.',
        },
      },
    ]);
  });

  it('never lets optional UI publication overturn provider admission or compensation', () => {
    const broken = {
      publish(): number {
        throw new Error('closed sink');
      },
    };
    expect(
      publishChatMediaPending(broken, {
        sessionId: SESSION_ID,
        tool: 'image_generate',
      }),
    ).toBe(false);
    expect(
      publishChatMediaFailed(
        broken,
        { sessionId: SESSION_ID, tool: 'image_generate' },
        'media_tool_failed',
      ),
    ).toBe(false);
  });

  it('binds pending to admitted chat authorization and failure to compensation', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../src/routes/media-runtime.ts'),
      'utf8',
    );
    const admitted = source.slice(
      source.indexOf('const authorization = await reserveChatMedia'),
      source.indexOf("authorizationOwner: 'chat' as const"),
    );
    expect(admitted).toMatch(
      /reserveChatMedia[\s\S]*publishChatMediaPending\(app\.eventsBus, authorization\)/,
    );
    const failed = source.slice(
      source.indexOf('const outcome = await compensateChatMedia'),
      source.indexOf("if (outcome === 'refund_pending')"),
    );
    expect(failed).toContain(
      'publishChatMediaFailed(app.eventsBus, context, body.errorCode)',
    );
    const denied = source.slice(
      source.indexOf("'chat media authorization denied'"),
      source.indexOf("app.post<{ Params: { authorizationId: string } }>")
    );
    expect(denied).toContain(
      "new ApiError(409, failureCode, 'Media generation could not be authorized')",
    );
    expect(denied).not.toContain("new ApiError(409, 'media_authorization_denied'");
  });

  it('never invents media activity from a silent chat completion', () => {
    const turnsSource = readFileSync(
      resolve(import.meta.dirname, '../src/services/turns.ts'),
      'utf8',
    );
    expect(turnsSource).not.toContain("tool: 'unknown'");
    expect(turnsSource).not.toMatch(
      /if \(event\.emptyTurn\)[\s\S]{0,300}type: 'media\.pending'/,
    );
    expect(turnsSource).toContain('DIRECT_CHAT_EMPTY_REPLY');
    expect(turnsSource).toContain('hasCurrentTurnMediaAuthorization');
  });

  it('authorizes channel media only through the exact live owner and agent binding', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../src/services/chat-media-authorization.ts'),
      'utf8',
    );
    const targetQuery = source.slice(
      source.indexOf('select s.id as session_id'),
      source.indexOf('order by a.account_id'),
    );
    expect(targetQuery).toContain("s.session_type is distinct from 'channel'");
    expect(targetQuery).toContain('s.channel_connection_id is null');
    expect(targetQuery).toContain('from channel_connections connection');
    expect(targetQuery).toContain("s.session_type = 'channel'");
    expect(targetQuery).toContain('connection.id = s.channel_connection_id');
    expect(targetQuery).toContain('connection.account_id = s.owner_id');
    expect(targetQuery).toContain('connection.agent_id = a.account_id');
    expect(targetQuery).toContain('a.owner_id = connection.account_id');
    expect(targetQuery).toContain("connection.channel in ('discord', 'telegram')");
    expect(targetQuery).toContain("connection.desired_state = 'active'");
    expect(source).not.toContain(
      "and s.session_type is distinct from 'channel' and s.channel_connection_id is null",
    );
  });
});
