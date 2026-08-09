import { describe, expect, it } from 'vitest';

import {
  localDisposableDatabaseUrl,
  localSourceDatabaseName,
} from './fixtures/disposable-database';

const scratch = /^proof_[a-f0-9]{8}$/;

describe('disposable PostgreSQL URL boundary', () => {
  it('derives only an allowlisted local scratch or maintenance target', () => {
    expect(localSourceDatabaseName(
      'postgres://user:password@127.0.0.1:5433/eden3_stg',
    )).toBe('eden3_stg');
    expect(localDisposableDatabaseUrl(
      'postgresql://user:password@localhost:5433/eden3_stg',
      'proof_deadbeef',
      scratch,
    )).toBe('postgresql://user:password@localhost:5433/proof_deadbeef');
    expect(localDisposableDatabaseUrl(
      'postgres://user@127.0.0.1:5433/eden3_stg',
      'postgres',
      scratch,
    )).toBe('postgres://user@127.0.0.1:5433/postgres');
    expect(() => localDisposableDatabaseUrl(
      'postgres://user@127.0.0.1:5433/eden3_stg',
      'eden3',
      scratch,
    )).toThrow(/non-disposable database/);
  });

  it('rejects ambiguous, redirected, protected-cluster, and normalized sources', () => {
    for (const source of [
      'postgres://user@127.0.0.1:5433',
      'postgres://user@127.0.0.1:5433/',
      'postgres://user@127.0.0.1:5433/scratch/../eden3',
      'postgres://user@127.0.0.1:5433/scratch/%2e%2e/eden3',
      'postgres://user@127.0.0.1:5433/%65den3',
      'postgres://user@127.0.0.1:5433/eden3_stg?database=eden3',
      'postgres://user@127.0.0.1:5433/eden3_stg#eden3',
      'postgres://user@localhost/eden3_stg',
      'postgres://user@localhost:5432/eden3_stg',
      'postgres://user@remote.example:5433/eden3_stg',
      'postgres://user@127.1:5433/eden3_stg',
    ]) {
      expect(() => localSourceDatabaseName(source), source).toThrow(
        /local disposable PostgreSQL source/i,
      );
      expect(() => localDisposableDatabaseUrl(source, 'proof_deadbeef', scratch), source)
        .toThrow(/local disposable PostgreSQL source/i);
    }
  });

  it('does not disclose URL credentials in errors', () => {
    const credential = 'never-print-this-password';
    let message = '';
    try {
      localDisposableDatabaseUrl(
        `postgres://user:${credential}@remote.example:5433/eden3_stg`,
        'proof_deadbeef',
        scratch,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/local disposable PostgreSQL source/i);
    expect(message).not.toContain(credential);
  });
});
