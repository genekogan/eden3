import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { VoiceKernel, voiceKernelInternals } from '../src/services/voice-kernel';

const TURN = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const BINDING = '77777777-7777-4777-8777-777777777777';
const RUNTIME_ACCOUNT = 'runtime-account';
const RUNTIME_AGENT = 'voice-agent';
const EXECUTION = '55555555-5555-4555-8555-555555555555';
const OPERATION_KEY = 'channel:66666666-6666-4666-8666-666666666666';
const TEXT = 'hello channel';
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

function contextRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: OWNER,
    agent_id: AGENT,
    session_id: null,
    channel: 'discord',
    metadata: { _runtimeBindingId: BINDING },
    runtime_account_id: RUNTIME_ACCOUNT,
    openclaw_id: RUNTIME_AGENT,
    voice_id: 'deepinfra:kokoro:af_bella:v1',
    voice_mode: 'always',
    ...overrides,
  };
}

function executionRow(status: 'transcoding' | 'completed' | 'failed' = 'transcoding') {
  return {
    id: EXECUTION,
    voice_id: 'deepinfra:kokoro:af_bella:v1',
    purpose: 'discord',
    status,
    output_url: `/media/voice/${EXECUTION}`,
    output_mime: 'audio/ogg',
    output_duration_ms: 1_000,
    output_size_bytes: 100,
    character_count: 13,
    reserved_manna: 1,
    request_sha256: 'a'.repeat(64),
    text_sha256: voiceKernelInternals.exactTranscript(TEXT, 'discord').sha256,
    idempotency_key: OPERATION_KEY,
    channel_turn_id: TURN,
  };
}

describe('channel voice deferred delivery saga', () => {
  it.each([
    ['runtime account', { runtimeAccountId: 'wrong-runtime' }, {}],
    ['agent', { agentId: 'wrong-agent' }, {}],
    ['binding generation', { bindingId: '88888888-8888-4888-8888-888888888888' }, {}],
    ['stored agent', {}, { openclaw_id: 'wrong-agent' }],
    ['malformed binding', {}, { metadata: { _runtimeBindingId: 'not-a-uuid' } }],
  ])('refuses a mismatched %s before quote, provider, or debit work', async (_label, inputMutation, rowMutation) => {
    const execute = vi.fn(async (statement: unknown) => {
      const query = queryText(statement);
      if (query.startsWith('select ct.account_id')) return [contextRow(rowMutation)];
      throw new Error(`unexpected query: ${query}`);
    });
    const kernel = kernelWith({ execute, transaction: vi.fn() });
    const quote = vi.spyOn(kernel, 'quote');
    const synthesize = vi.spyOn(kernel, 'synthesize');

    await expect(kernel.channelVoiceNote({
      turnId: TURN,
      connectionId: CONNECTION,
      runtimeAccountId: RUNTIME_ACCOUNT,
      agentId: RUNTIME_AGENT,
      bindingId: BINDING,
      text: TEXT,
      idempotencyKey: OPERATION_KEY,
      ...inputMutation,
    })).rejects.toMatchObject({ statusCode: 404, code: 'channel_voice_unavailable' });
    expect(quote).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('replays a durable playable output after an ambiguous response without provider or debit work', async () => {
    const execute = vi.fn(async (statement: unknown) => {
      const query = queryText(statement);
      if (query.startsWith('select ct.account_id')) return [contextRow()];
      if (query.startsWith('select * from voice_executions')) return [executionRow()];
      if (query.startsWith('select waveform')) return [{ waveform: 'AQID' }];
      return [];
    });
    const kernel = kernelWith({ execute, transaction: vi.fn() });
    const quote = vi.spyOn(kernel, 'quote');
    const synthesize = vi.spyOn(kernel, 'synthesize');

    const result = await kernel.channelVoiceNote({
      turnId: TURN, connectionId: CONNECTION, runtimeAccountId: RUNTIME_ACCOUNT,
      agentId: RUNTIME_AGENT, bindingId: BINDING, text: TEXT, idempotencyKey: OPERATION_KEY,
    });
    expect(result).toMatchObject({ id: EXECUTION, status: 'transcoding', replayed: true, waveform: 'AQID' });
    expect(quote).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('keeps new channel output deferred until native delivery', async () => {
    const execute = vi.fn(async (statement: unknown) => {
      const query = queryText(statement);
      if (query.startsWith('select ct.account_id')) return [contextRow()];
      if (query.startsWith('select * from voice_executions')) return [];
      if (query.startsWith('select waveform')) return [{ waveform: 'AQID' }];
      return [];
    });
    const kernel = kernelWith({ execute, transaction: vi.fn() });
    vi.spyOn(kernel, 'quote').mockResolvedValue({ quoteId: 'quote-1' } as never);
    const synthesize = vi.spyOn(kernel, 'synthesize').mockResolvedValue({
      ...executionRow(), replayed: false,
    } as never);

    await kernel.channelVoiceNote({
      turnId: TURN, connectionId: CONNECTION, runtimeAccountId: RUNTIME_ACCOUNT,
      agentId: RUNTIME_AGENT, bindingId: BINDING, text: TEXT, idempotencyKey: OPERATION_KEY,
    });
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      channelTurnId: TURN,
      idempotencyKey: OPERATION_KEY,
      deferSettlement: true,
    }));
  });

  it('atomically settles execution and usage only behind a delivered channel row', async () => {
    const executed: string[] = [];
    const tx = { execute: vi.fn(async (statement: unknown) => {
      const query = queryText(statement);
      executed.push(query);
      if (query.startsWith('select v.*')) return [executionRow()];
      if (query.startsWith("update voice_executions set status='completed'")) return [{ id: EXECUTION }];
      if (query.startsWith("update usage_events set status='completed'")) return [{ id: 'usage-1' }];
      return [];
    }) };
    const kernel = kernelWith({
      execute: vi.fn(),
      transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => await work(tx)),
    });
    await expect(kernel.settleChannelVoiceDelivery(TURN)).resolves.toBe(true);
    expect(executed[0]).toContain("ct.status='delivered'");
    expect(executed).toEqual(expect.arrayContaining([
      expect.stringContaining("update voice_executions set status='completed'"),
      expect.stringContaining("update usage_events set status='completed'"),
    ]));
  });

  it('refuses voice compensation until the channel ledger is terminal-refunded', async () => {
    let refunded = false;
    const transaction = vi.fn(async (work: (value: { execute: (statement: unknown) => Promise<unknown[]> }) => Promise<unknown>) =>
      await work({ execute: vi.fn(async (statement: unknown) => {
        expect(queryText(statement)).toContain("ct.status='refunded'");
        return refunded ? [{ id: EXECUTION, status: 'transcoding' }] : [];
      }) }),
    );
    const kernel = kernelWith({ transaction, execute: vi.fn() });
    const fail = vi.spyOn(kernel as never, 'failExecution' as never).mockResolvedValue(undefined as never);
    const cleanup = vi.spyOn(kernel as never, 'cleanupFailedArtifact' as never).mockResolvedValue(undefined as never);
    await expect(kernel.refundChannelVoiceDelivery(TURN)).resolves.toBe(false);
    expect(fail).not.toHaveBeenCalled();
    refunded = true;
    await expect(kernel.refundChannelVoiceDelivery(TURN)).resolves.toBe(true);
    expect(fail).toHaveBeenCalledWith(EXECUTION, `voice:${EXECUTION}`, 'channel_delivery_failed');
    expect(cleanup).toHaveBeenCalledWith(EXECUTION);
  });
});
