import { describe, expect, it } from 'vitest';

import { appendTranscriptDelta } from '../src/services/cartesia-transcription-provider';
import { TRANSCRIPTION_MAX_TRANSCRIPT_CHARS } from '../src/services/transcriptions';

describe('Cartesia transcription provider bounds', () => {
  it('rejects provider-controlled transcript deltas before unbounded concatenation', () => {
    const atLimit = appendTranscriptDelta(
      'a'.repeat(TRANSCRIPTION_MAX_TRANSCRIPT_CHARS - 1),
      'b',
    );
    expect(atLimit).toHaveLength(TRANSCRIPTION_MAX_TRANSCRIPT_CHARS);
    expect(() => appendTranscriptDelta(atLimit, 'c')).toThrowError(
      expect.objectContaining({ code: 'provider_response_invalid' }),
    );
  });
});
