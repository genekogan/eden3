import { describe, expect, it, vi } from 'vitest';

import { attachAutomaticDirectVoiceNote } from '../src/routes/chat';

const OWNER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const MESSAGE = '33333333-3333-4333-8333-333333333333';

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe('automatic direct-chat voice after a committed turn', () => {
  it('attaches exactly once with the stable message key and publishes only after custody', async () => {
    let resolveAttachment!: (value: unknown) => void;
    const attachment = new Promise((resolve) => { resolveAttachment = resolve; });
    const processAutomaticDirectVoice = vi.fn(() => attachment);
    const markDirectVoiceRefreshPublished = vi.fn(async () => true);
    const publishChanged = vi.fn();
    const onError = vi.fn();

    const result = attachAutomaticDirectVoiceNote({
      voiceKernel: { processAutomaticDirectVoice, markDirectVoiceRefreshPublished } as never,
      ownerAccountId: OWNER,
      sessionId: SESSION,
      assistantMessageId: MESSAGE,
      publishChanged,
      onError,
    });

    expect(processAutomaticDirectVoice).toHaveBeenCalledTimes(1);
    expect(processAutomaticDirectVoice).toHaveBeenCalledWith(MESSAGE);
    expect(publishChanged).not.toHaveBeenCalled();

    resolveAttachment({ execution: {}, message: { id: MESSAGE }, refreshPending: true });
    await expect(result).resolves.toBe('attached');
    expect(publishChanged).toHaveBeenCalledTimes(1);
    expect(markDirectVoiceRefreshPublished).toHaveBeenCalledWith(MESSAGE);
    expect(onError).not.toHaveBeenCalled();
  });

  it('treats off/on-demand eligibility as a quiet no-op', async () => {
    const processAutomaticDirectVoice = vi.fn(async () => {
      throw codedError('voice_message_not_eligible');
    });
    const publishChanged = vi.fn();
    const onError = vi.fn();

    await expect(attachAutomaticDirectVoiceNote({
      voiceKernel: { processAutomaticDirectVoice, markDirectVoiceRefreshPublished: vi.fn() } as never,
      ownerAccountId: OWNER,
      sessionId: SESSION,
      assistantMessageId: MESSAGE,
      publishChanged,
      onError,
    })).resolves.toBe('not_enabled');
    expect(processAutomaticDirectVoice).toHaveBeenCalledTimes(1);
    expect(publishChanged).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('contains provider failures so the committed chat cannot fail or duplicate', async () => {
    const failure = codedError('voice_provider_unavailable');
    const processAutomaticDirectVoice = vi.fn(async () => { throw failure; });
    const publishChanged = vi.fn();
    const onError = vi.fn();

    await expect(attachAutomaticDirectVoiceNote({
      voiceKernel: { processAutomaticDirectVoice, markDirectVoiceRefreshPublished: vi.fn() } as never,
      ownerAccountId: OWNER,
      sessionId: SESSION,
      assistantMessageId: MESSAGE,
      publishChanged,
      onError,
    })).resolves.toBe('failed');
    expect(processAutomaticDirectVoice).toHaveBeenCalledTimes(1);
    expect(publishChanged).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
