import { describe, expect, it } from 'vitest';

import { managedRuntimeBootstrapStatements } from '../src/managed-runtime-bootstrap';

describe('managed PostgreSQL runtime role bootstrap', () => {
  it('creates a bounded non-inheriting runtime role with exact data-plane authority', () => {
    const statements = managedRuntimeBootstrapStatements({
      databaseName: 'eden3_managed_rehearsal',
      roleName: 'eden3_runtime_rehearsal',
      password: 'synthetic_credential_material_1234567890',
    });
    const sql = statements.join(';\n');
    expect(statements).toHaveLength(16);
    expect(sql).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public');
    expect(sql).toContain('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public');
    expect(sql).toContain('GRANT SELECT ON TABLE drizzle.__drizzle_migrations');
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.account_erasure_assert_account_writable(uuid)',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.account_erasure_lock_legacy_content(text,text,text,text,text,text,text,text,text,text)',
    );
    expect(sql.indexOf('SET ROLE eden3_erasure_guard')).toBeLessThan(
      sql.indexOf('GRANT EXECUTE ON FUNCTION public.account_erasure_assert_account_writable(uuid)'),
    );
    expect(sql.indexOf('GRANT EXECUTE ON FUNCTION public.account_erasure_assert_account_writable(uuid)')).toBeLessThan(
      sql.indexOf('RESET ROLE'),
    );
    expect(sql.indexOf('GRANT EXECUTE ON FUNCTION public.account_erasure_lock_legacy_content(text,text,text,text,text,text,text,text,text,text)')).toBeLessThan(
      sql.indexOf('RESET ROLE'),
    );
    expect(sql).toContain("SET statement_timeout = '30s'");
    expect(sql).toContain("SET lock_timeout = '5s'");
    expect(sql).toContain("SET idle_in_transaction_session_timeout = '15s'");
    expect(sql).not.toMatch(/GRANT .*CREATE|GRANT .*eden3_erasure_/);
  });

  it.each([
    { databaseName: 'postgres', roleName: 'runtime', password: 'synthetic_credential_material_1234567890' },
    { databaseName: 'eden3 managed', roleName: 'eden3_runtime_rehearsal', password: 'synthetic_credential_material_1234567890' },
    { databaseName: 'eden3-managed', roleName: 'eden3_runtime_rehearsal', password: 'synthetic_credential_material_1234567890' },
    { databaseName: 'eden3_managed_rehearsal', roleName: 'eden3_runtime_rehearsal;drop role x', password: 'synthetic_credential_material_1234567890' },
    { databaseName: 'eden3_managed_rehearsal', roleName: 'eden3_runtime_rehearsal', password: "unsafe'password_material_1234567890" },
  ])('refuses a noncanonical bootstrap input %#', (options) => {
    expect(() => managedRuntimeBootstrapStatements(options)).toThrow(/not canonical/);
  });
});
