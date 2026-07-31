import { describe, expect, it } from 'vitest';

import { isValidChannelRuntimeAuthorization } from '../src/services/channel-runtime-auth.js';

describe('channel runtime authorization', () => {
  it('accepts only the exact bearer credential', () => {
    expect(isValidChannelRuntimeAuthorization('Bearer runtime-secret', 'runtime-secret')).toBe(
      true,
    );
    expect(isValidChannelRuntimeAuthorization('Bearer runtime-secrex', 'runtime-secret')).toBe(
      false,
    );
    expect(isValidChannelRuntimeAuthorization('runtime-secret', 'runtime-secret')).toBe(false);
  });

  it('fails closed when runtime auth is not configured', () => {
    expect(isValidChannelRuntimeAuthorization('Bearer anything', undefined)).toBe(false);
    expect(isValidChannelRuntimeAuthorization(undefined, 'secret')).toBe(false);
    expect(isValidChannelRuntimeAuthorization(['Bearer secret'], 'secret')).toBe(false);
  });
});
