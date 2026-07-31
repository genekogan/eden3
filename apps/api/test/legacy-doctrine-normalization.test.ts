import { MAX_BOOTSTRAP_FILE_CHARS, findPersonaBanalities } from '@eden3/shared';
import { describe, expect, it } from 'vitest';

import { planLegacyDoctrineNormalization } from '../src/services/legacy-doctrine-normalization';

describe('legacy doctrine normalization', () => {
  it('leaves an already-compliant value byte-identical', () => {
    const original = 'Speak briefly, show your reasoning, and make concrete artifacts.';
    expect(planLegacyDoctrineNormalization(original, 'memory/legacy/persona-x.md')).toEqual({
      changed: false,
      content: original,
      reasons: [],
    });
  });

  it('preserves the useful prefix, removes banal sentences, and stays within budget', () => {
    const original = [
      'A specific opening sentence about artistic practice.',
      'You are not a chatbot or an assistant.',
      'You are a living archive and an ongoing experiment.',
      'Detailed reference material. '.repeat(1_500),
    ].join(' ');
    const result = planLegacyDoctrineNormalization(
      original,
      'memory/legacy/persona-deadbeef.md',
    );
    expect(result.changed).toBe(true);
    expect(result.content).toContain('A specific opening sentence');
    expect(result.content).toContain('You are a living archive');
    expect(result.content).toContain('memory/legacy/persona-deadbeef.md');
    expect(result.content.length).toBeLessThanOrEqual(MAX_BOOTSTRAP_FILE_CHARS);
    expect(findPersonaBanalities(result.content)).toEqual([]);
  });
});
