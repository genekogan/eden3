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
    const directVoiceNote = vi.fn(() => attachment);
    const publishChanged = vi.fn();
    const onError = vi.fn();

    const result = attachAutomaticDirectVoiceNote({
      voiceKernel: { directVoiceNote } as never,
      ownerAccountId: OWNER,
      sessionId: SESSION,
      assistantMessageId: MESSAGE,
      publishChanged,
      onError,
    });

    expect(directVoiceNote).toHaveBeenCalledTimes(1);
    expect(directVoiceNote).toHaveBeenCalledWith(
      OWNER,
      SESSION,
      MESSAGE,
      `direct-voice:${MESSAGE}`,
      'always',
    );
    expect(publishChanged).not.toHaveBeenCalled();

    resolveAttachment({ execution: {}, message: { id: MESSAGE } });
    await expect(result).resolves.toBe('attached');
    expect(publishChanged).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('treats off/on-demand eligibility as a quiet no-op', async () => {
    const directVoiceNote = vi.fn(async () => {
      throw codedError('voice_message_not_eligible');
    });
    const publishChanged = vi.fn();
    const onError = vi.fn();

    await expect(attachAutomaticDirectVoiceNote({
      voiceKernel: { directVoiceNote } as never,
      ownerAccountId: OWNER,
      sessionId: SESSION,
      assistantMessageId: MESSAGE,
      publishChanged,
      onError,
    })).resolves.toBe('not_enabled');
    expect(directVoiceNote).toHaveBeenCalledTimes(1);
    expect(publishChanged).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('contains provider failures so the committed chat cannot fail or duplicate', async () => {
    const failure = codedError('voice_provider_unavailable');
    const directVoiceNote = vi.fn(async () => { throw failure; });
    const publishChanged = vi.fn();
    const onError = vi.fn();

    await expect(attachAutomaticDirectVoiceNote({
      voiceKernel: { directVoiceNote } as never,
      ownerAccountId: OWNER,
      sessionId: SESSION,
      assistantMessageId: MESSAGE,
      publishChanged,
      onError,
    })).resolves.toBe('failed');
    expect(directVoiceNote).toHaveBeenCalledTimes(1);
    expect(publishChanged).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
