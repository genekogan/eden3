import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { VoiceKernel } from '../src/services/voice-kernel';

const MESSAGE = '33333333-3333-4333-8333-333333333333';
const SESSION = '22222222-2222-4222-8222-222222222222';
const OWNER = '11111111-1111-4111-8111-111111111111';
const AGENT = '44444444-4444-4444-8444-444444444444';
const EXECUTION = '55555555-5555-4555-8555-555555555555';

const dialect = new PgDialect();
function queryText(statement: unknown): string {
  return dialect.sqlToQuery(statement as Parameters<PgDialect['sqlToQuery']>[0]).sql.replace(/\s+/g, ' ').trim();
}

function kernelWith(db: unknown) {
  return new VoiceKernel({
    db: db as never,
    mediaStore: { put: vi.fn() } as never,
    audio: {} as never,
    providers: {},
    cleanupArtifact: vi.fn(),
  });
}

function rowsFor(statement: unknown, missing?: 'message' | 'usage' | 'job', completed = false): unknown[] {
  const query = queryText(statement);
  if (query.startsWith('select * from direct_voice_jobs')) return [{
    message_id: MESSAGE, owner_account_id: OWNER, session_id: SESSION, agent_account_id: AGENT,
    voice_id: 'deepinfra:kokoro:af_bella:v1', text_sha256: 'a'.repeat(64), mode: 'always',
    status: completed ? 'completed' : 'attachment_pending', generation: 0, execution_id: EXECUTION, last_error_code: null,
    updated_at: new Date(),
  }];
  if (query.startsWith('select * from voice_executions')) return [{
    id: EXECUTION, voice_id: 'deepinfra:kokoro:af_bella:v1', purpose: 'chat', status: completed ? 'completed' : 'transcoding',
    output_url: '/media/voice.ogg', output_mime: 'audio/ogg', output_duration_ms: 1_000,
    output_size_bytes: 100, character_count: 5, reserved_manna: 1, request_sha256: 'b'.repeat(64),
  }];
  if (query.startsWith('select id,external_id,session_id')) return [{
    id: MESSAGE, external_id: null, session_id: SESSION, sender_id: AGENT, role: 'assistant', content: 'hello',
    attachments: [{ url: '/media/voice.ogg', mime: 'audio/ogg', durationMs: 1_000, voiceExecutionId: EXECUTION }],
    tool_calls: null, reactions: null, reply_to_external_id: null, created_at: new Date(),
  }];
  if (query.startsWith('update messages set attachments')) return missing !== 'message' ? [{
    id: MESSAGE, external_id: null, session_id: SESSION, sender_id: AGENT, role: 'assistant', content: 'hello',
    attachments: [{ url: '/media/voice.ogg', mime: 'audio/ogg', durationMs: 1_000, voiceExecutionId: EXECUTION }],
    tool_calls: null, reactions: null, reply_to_external_id: null, created_at: new Date(),
  }] : [];
  if (query.startsWith("update voice_executions set status='completed'")) return [{
    id: EXECUTION, voice_id: 'deepinfra:kokoro:af_bella:v1', purpose: 'chat', status: 'completed',
    output_url: '/media/voice.ogg', output_mime: 'audio/ogg', output_duration_ms: 1_000,
    output_size_bytes: 100, character_count: 5, reserved_manna: 1, request_sha256: 'b'.repeat(64),
  }];
  if (query.startsWith("update usage_events set status='completed'")) return missing === 'usage' ? [] : [{ id: 'usage-1' }];
  if (query.startsWith("update direct_voice_jobs set status='completed'")) return missing === 'job' ? [] : [{ message_id: MESSAGE }];
  return [];
}

describe('direct voice attachment settlement saga', () => {
  it('attaches the message and settles execution, usage, and job in one transaction', async () => {
    const executed: string[] = [];
    const tx = { execute: vi.fn(async (statement: unknown) => {
      executed.push(queryText(statement));
      return rowsFor(statement);
    }) };
    const transaction = vi.fn(async (work: (handle: typeof tx) => Promise<unknown>) => await work(tx));
    const outsideExecute = vi.fn();
    const kernel = kernelWith({ transaction, execute: outsideExecute });

    const result = await (kernel as unknown as {
      settleDirectVoiceAttachment(messageId: string): Promise<{ execution: { status: string }; message: { id: string } }>;
    }).settleDirectVoiceAttachment(MESSAGE);

    expect(result).toMatchObject({ execution: { status: 'completed' }, message: { id: MESSAGE } });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(outsideExecute).not.toHaveBeenCalled();
    expect(executed.findIndex((query) => query.startsWith('update messages set attachments'))).toBeLessThan(
      executed.findIndex((query) => query.startsWith("update voice_executions set status='completed'")),
    );
    expect(executed).toEqual(expect.arrayContaining([
      expect.stringContaining("update usage_events set status='completed'"),
      expect.stringContaining("update direct_voice_jobs set status='completed'"),
    ]));
  });

  it('marks only the atomic attachment transition as newly settled', async () => {
    const executed: string[] = [];
    const tx = { execute: vi.fn(async (statement: unknown) => {
      executed.push(queryText(statement));
      return rowsFor(statement, undefined, true);
    }) };
    const kernel = kernelWith({
      transaction: vi.fn(async (work: (handle: typeof tx) => Promise<unknown>) => await work(tx)),
      execute: vi.fn(async () => []),
    });
    const result = await (kernel as unknown as {
      settleDirectVoiceAttachment(messageId: string): Promise<{ newlySettled: boolean }>;
    }).settleDirectVoiceAttachment(MESSAGE);
    expect(result.newlySettled).toBe(false);
    expect(executed.some((query) => query.startsWith('update messages set attachments'))).toBe(false);
    expect(executed.some((query) => query.startsWith("update usage_events set status='completed'"))).toBe(false);
  });

  it('does not settle money when the assistant attachment cannot be committed', async () => {
    const executed: string[] = [];
    const tx = { execute: vi.fn(async (statement: unknown) => {
      executed.push(queryText(statement));
      return rowsFor(statement, 'message');
    }) };
    const outsideExecute = vi.fn(async () => []);
    const kernel = kernelWith({
      transaction: vi.fn(async (work: (handle: typeof tx) => Promise<unknown>) => await work(tx)),
      execute: outsideExecute,
    });

    await expect((kernel as unknown as {
      settleDirectVoiceAttachment(messageId: string): Promise<unknown>;
    }).settleDirectVoiceAttachment(MESSAGE)).rejects.toMatchObject({ code: 'voice_message_not_eligible' });
    expect(executed.some((query) => query.startsWith("update voice_executions set status='completed'"))).toBe(false);
    expect(executed.some((query) => query.startsWith("update usage_events set status='completed'"))).toBe(false);
    // Compensating refund/cleanup runs outside the rolled-back attachment transaction.
    expect(outsideExecute).toHaveBeenCalled();
  });

  it.each(['usage', 'job'] as const)('rolls back completion when %s terminal custody is missing', async (missing) => {
    const executed: string[] = [];
    const tx = { execute: vi.fn(async (statement: unknown) => {
      executed.push(queryText(statement));
      return rowsFor(statement, missing);
    }) };
    const kernel = kernelWith({
      transaction: vi.fn(async (work: (handle: typeof tx) => Promise<unknown>) => await work(tx)),
      execute: vi.fn(async () => []),
    });
    await expect((kernel as unknown as {
      settleDirectVoiceAttachment(messageId: string): Promise<unknown>;
    }).settleDirectVoiceAttachment(MESSAGE)).rejects.toThrow(`direct voice settlement lost ${missing} custody`);
    expect(executed).toContainEqual(expect.stringContaining("update voice_executions set status='completed'"));
    if (missing === 'usage') {
      expect(executed.some((query) => query.startsWith("update direct_voice_jobs set status='completed'"))).toBe(false);
    }
  });
});
