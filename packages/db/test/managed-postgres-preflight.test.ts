import { describe, expect, it } from 'vitest';

import {
  inspectManagedPostgres,
  parseManagedPostgresUrl,
} from '../src/managed-postgres-preflight';

describe('managed PostgreSQL read-only rehearsal boundary', () => {
  it('requires an exact remote credentialed verify-full database without exposing authority', () => {
    const authority = parseManagedPostgresUrl(
      'postgres://eden3_runtime:synthetic@db.example.invalid:5432/eden3_managed_rehearsal?sslmode=verify-full',
      'eden3_managed_rehearsal',
    );
    expect(authority).toEqual({
      databaseName: 'eden3_managed_rehearsal',
      port: 5432,
      hostSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      tlsMode: 'verify-full',
    });
    expect(JSON.stringify(authority)).not.toContain('synthetic');
    expect(JSON.stringify(authority)).not.toContain('db.example');
  });

  it.each([
    'postgres://eden3_runtime:synthetic@127.0.0.1:5432/eden3_managed_rehearsal?sslmode=verify-full',
    'postgres://eden3_runtime:synthetic@db.example.invalid:5432/eden3_managed_rehearsal?sslmode=require',
    'postgres://eden3_runtime@db.example.invalid:5432/eden3_managed_rehearsal?sslmode=verify-full',
    'postgres://eden3_runtime:synthetic@db.example.invalid:5432/postgres?sslmode=verify-full',
    'postgres://eden3_runtime:synthetic@db.example.invalid:5432/eden3-managed-rehearsal?sslmode=verify-full',
    'postgres://eden3_runtime:synthetic@db.example.invalid:5432/eden3_managed_rehearsal?sslmode=verify-full&application_name=eden3',
  ])('refuses unsafe or ambiguous managed URL %s', (url) => {
    expect(() => parseManagedPostgresUrl(url, 'eden3_managed_rehearsal')).toThrow(/exact credentialed TLS/);
  });

  it('accepts only a read-only PostgreSQL 16+ transaction with the migrated catalog', async () => {
    let call = 0;
    const sql = async () => {
      call += 1;
      return call === 1
        ? [{
            databaseName: 'eden3_managed_rehearsal',
            serverVersion: '16.4',
            serverVersionNum: '160004',
            maxConnections: '100',
            inRecovery: false,
            transactionReadOnly: 'on',
          }]
        : [{ migrationCount: 44, latestMigrationId: 44 }];
    };
    const authority = parseManagedPostgresUrl(
      'postgres://eden3_runtime:synthetic@db.example.invalid/eden3_managed_rehearsal?sslmode=verify-full',
      'eden3_managed_rehearsal',
    );
    await expect(inspectManagedPostgres(sql as never, authority)).resolves.toMatchObject({
      databaseName: 'eden3_managed_rehearsal',
      transactionReadOnly: true,
      serverVersionNum: 160004,
      migrationCount: 44,
      latestMigrationId: 44,
    });
  });

  it('refuses writable, old, wrong-database, or unmigrated observations', async () => {
    const authority = parseManagedPostgresUrl(
      'postgres://eden3_runtime:synthetic@db.example.invalid/eden3_managed_rehearsal?sslmode=verify-full',
      'eden3_managed_rehearsal',
    );
    let call = 0;
    const sql = async () => {
      call += 1;
      return call === 1
        ? [{
            databaseName: 'wrong',
            serverVersion: '15.9',
            serverVersionNum: '150009',
            maxConnections: '5',
            inRecovery: false,
            transactionReadOnly: 'off',
          }]
        : [{ migrationCount: 0, latestMigrationId: null }];
    };
    await expect(inspectManagedPostgres(sql as never, authority)).rejects.toThrow(/exact database contract/);
  });
});
