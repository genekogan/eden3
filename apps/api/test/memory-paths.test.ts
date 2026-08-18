import { describe, expect, it } from 'vitest';

import {
  memoryUserFilename,
  memoryUserRelativePath,
  safeMemoryPeerName,
} from '../src/services/memory-paths';

describe('per-user memory paths', () => {
  it('uses the readable name plus immutable account id', () => {
    expect(memoryUserFilename('Example User', '019fb6b9-1071-7741-bfc9-7143c4869375')).toBe(
      'example-user-019fb6b9-1071-7741-bfc9-7143c4869375.md',
    );
    expect(memoryUserRelativePath('Example User', 'abc_123')).toBe(
      'memory/users/example-user-abc_123.md',
    );
  });

  it('keeps same-name peers separate and neutralizes path input', () => {
    expect(memoryUserFilename('Alice', 'id-one')).not.toBe(memoryUserFilename('Alice', 'id-two'));
    expect(safeMemoryPeerName('../../Éve / secrets')).toBe('eve-secrets');
    expect(() => memoryUserFilename('Alice', '../id')).toThrow('invalid Eden account id');
  });
});
