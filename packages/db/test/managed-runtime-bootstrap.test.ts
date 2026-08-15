import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { managedRuntimeBootstrapStatements } from '../src/managed-runtime-bootstrap';

describe('managed PostgreSQL runtime role bootstrap', () => {
  it('keeps existing-role upgrade on one transaction and validates least privilege', () => {
    const source = readFileSync(new URL('../src/managed-runtime-bootstrap.ts', import.meta.url), 'utf8');
    const signature = source.slice(source.indexOf('export async function upgradeManagedRuntimeVoicePrivilege'));
    expect(signature).toContain('sql: postgres.TransactionSql');
    expect(signature).toContain("SET LOCAL ROLE eden3_erasure_guard");
    expect(signature).toContain("pg_has_role(rolname,'eden3_erasure_operator','member')");
    expect(signature).toContain("pg_has_role(rolname,'eden3_erasure_guard','member')");
    expect(signature).toContain("pg_has_role(rolname,'eden3_erasure_terminal_writer','member')");
    expect(signature).toContain("has_schema_privilege(rolname,'public','CREATE')");
    expect(signature).not.toContain('sql: postgres.Sql | postgres.TransactionSql');
  });
  it('creates a bounded non-inheriting runtime role with exact data-plane authority', () => {
    const statements = managedRuntimeBootstrapStatements({
      databaseName: 'eden3_managed_rehearsal',
      roleName: 'eden3_runtime_rehearsal',
      password: 'synthetic_credential_material_1234567890',
    });
    const sql = statements.join(';\n');
    expect(statements).toHaveLength(17);
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
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.account_erasure_assert_voice_output_writable(text)',
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
    expect(sql.indexOf('GRANT EXECUTE ON FUNCTION public.account_erasure_assert_voice_output_writable(text)')).toBeLessThan(
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
