import { describe, expect, it } from 'vitest';

import {
  appendTranscriptDelta,
  CARTESIA_CANCEL_CHECK_FRAMES,
  shouldCheckTranscriptionCancellation,
} from '../src/services/cartesia-transcription-provider';
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

  it('bounds cancellation reads to one per five seconds during realtime replay', () => {
    expect(CARTESIA_CANCEL_CHECK_FRAMES).toBe(50);
    expect(shouldCheckTranscriptionCancellation(0)).toBe(true);
    expect(shouldCheckTranscriptionCancellation(49)).toBe(false);
    expect(shouldCheckTranscriptionCancellation(50)).toBe(true);
    expect(Array.from({ length: 6_000 }, (_, frame) => frame)
      .filter(shouldCheckTranscriptionCancellation)).toHaveLength(120);
  });
});
