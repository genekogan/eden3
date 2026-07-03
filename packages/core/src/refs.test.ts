import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { isHex24, isUuid } from './refs';

describe('isHex24', () => {
  it('accepts 24-char hex strings (Mongo ObjectIds)', () => {
    expect(isHex24('665f0a1b2c3d4e5f60718293')).toBe(true);
    expect(isHex24('665F0A1B2C3D4E5F60718293')).toBe(true); // case-insensitive
  });

  it('rejects everything else', () => {
    expect(isHex24('')).toBe(false);
    expect(isHex24('665f0a1b2c3d4e5f6071829')).toBe(false); // 23 chars
    expect(isHex24('665f0a1b2c3d4e5f607182934')).toBe(false); // 25 chars
    expect(isHex24('665f0a1b2c3d4e5f6071829g')).toBe(false); // non-hex
    expect(isHex24(randomUUID())).toBe(false);
  });
});

describe('isUuid', () => {
  it('accepts canonical uuids of any case', () => {
    const id = randomUUID();
    expect(isUuid(id)).toBe(true);
    expect(isUuid(id.toUpperCase())).toBe(true);
  });

  it('rejects non-uuid strings', () => {
    expect(isUuid('')).toBe(false);
    expect(isUuid('665f0a1b2c3d4e5f60718293')).toBe(false);
    expect(isUuid(randomUUID().replaceAll('-', ''))).toBe(false); // unhyphenated
    expect(isUuid(`${randomUUID()}x`)).toBe(false);
  });
});
