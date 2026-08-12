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
  });
});
