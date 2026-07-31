import { describe, expect, it } from 'vitest';

import {
  legacyVoucherAllowedUserIds,
  legacyVoucherAllowsAccount,
  legacyVoucherExternalId,
  legacyVoucherHasMalformedCriticalFields,
} from './billing';

describe('legacyVoucherExternalId', () => {
  it('accepts only a non-empty imported source identity', () => {
    expect(legacyVoucherExternalId({ legacyExternalId: '66c0d1e2f3a4b5c6d7e8f0aa' })).toBe(
      '66c0d1e2f3a4b5c6d7e8f0aa',
    );
    expect(legacyVoucherExternalId({ legacyExternalId: '' })).toBeNull();
    expect(legacyVoucherExternalId({ legacyExternalId: 42 })).toBeNull();
    expect(legacyVoucherExternalId(null)).toBeNull();
  });
});

describe('legacy voucher allowlists', () => {
  it('deduplicates valid legacy ids and rejects malformed metadata', () => {
    expect(
      legacyVoucherAllowedUserIds({ allowedUserIds: ['clerk-a', '', 42, 'clerk-a', 'mongo-b'] }),
    ).toEqual(['clerk-a', 'mongo-b']);
    expect(legacyVoucherAllowedUserIds({ allowedUserIds: 'clerk-a' })).toEqual([]);
    expect(legacyVoucherAllowedUserIds(null)).toEqual([]);
  });

  it('treats an empty list as public and matches either Clerk or Mongo identity', () => {
    expect(legacyVoucherAllowsAccount({}, [])).toBe(true);
    expect(
      legacyVoucherAllowsAccount({ allowedUserIds: ['clerk-a'] }, ['mongo-a', 'clerk-a']),
    ).toBe(true);
    expect(
      legacyVoucherAllowsAccount({ allowedUserIds: ['clerk-b'] }, ['mongo-a', 'clerk-a']),
    ).toBe(false);
  });
});

describe('legacy malformed-critical marker', () => {
  it('fails closed for the durable ETL marker while ignoring absent/empty markers', () => {
    expect(
      legacyVoucherHasMalformedCriticalFields({
        legacyMalformedCriticalFields: ['maxUses'],
      }),
    ).toBe(true);
    expect(
      legacyVoucherHasMalformedCriticalFields({ legacyMalformedCriticalFields: true }),
    ).toBe(true);
    expect(
      legacyVoucherHasMalformedCriticalFields({ legacyMalformedCriticalFields: [] }),
    ).toBe(false);
    expect(legacyVoucherHasMalformedCriticalFields({})).toBe(false);
  });
});
