import { createHash } from 'node:crypto';
import type postgres from 'postgres';

const ROLE_NAME = /^eden3_runtime_[a-z0-9_]{1,43}$/;
const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/;
const PASSWORD = /^[A-Za-z0-9_-]{32,128}$/;

export interface ManagedRuntimeBootstrapOptions {
  databaseName: string;
  roleName: string;
  password: string;
}

export interface ManagedRuntimeBootstrapEvidence {
  databaseName: string;
  roleSha256: string;
  tableCount: number;
  sequenceCount: number;
  statementTimeout: '30s';
  lockTimeout: '5s';
  idleInTransactionTimeout: '15s';
}

function assertOptions(options: ManagedRuntimeBootstrapOptions): void {
  if (
    !DATABASE_NAME.test(options.databaseName) ||
    !ROLE_NAME.test(options.roleName) ||
    !PASSWORD.test(options.password)
  ) {
    throw new Error('managed runtime bootstrap inputs are not canonical');
  }
}

export function managedRuntimeBootstrapStatements(
  options: ManagedRuntimeBootstrapOptions,
): readonly string[] {
  assertOptions(options);
  const { databaseName, roleName, password } = options;
  return [
    `CREATE ROLE ${roleName} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    `GRANT CONNECT ON DATABASE ${databaseName} TO ${roleName}`,
    `GRANT USAGE ON SCHEMA public TO ${roleName}`,
    `GRANT USAGE ON SCHEMA drizzle TO ${roleName}`,
    `GRANT SELECT ON TABLE drizzle.__drizzle_migrations TO ${roleName}`,
    'SET ROLE eden3_erasure_guard',
    `GRANT EXECUTE ON FUNCTION public.account_erasure_assert_account_writable(uuid) TO ${roleName}`,
    `GRANT EXECUTE ON FUNCTION public.account_erasure_lock_legacy_content(text,text,text,text,text,text,text,text,text,text) TO ${roleName}`,
    'RESET ROLE',
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleName}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${roleName}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roleName}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${roleName}`,
    `ALTER ROLE ${roleName} IN DATABASE ${databaseName} SET statement_timeout = '30s'`,
    `ALTER ROLE ${roleName} IN DATABASE ${databaseName} SET lock_timeout = '5s'`,
    `ALTER ROLE ${roleName} IN DATABASE ${databaseName} SET idle_in_transaction_session_timeout = '15s'`,
  ] as const;
}

export async function bootstrapManagedRuntimeRole(
  sql: postgres.Sql | postgres.TransactionSql,
  options: ManagedRuntimeBootstrapOptions,
): Promise<ManagedRuntimeBootstrapEvidence> {
  const existing = await sql`
    select 1 as present from pg_roles where rolname=${options.roleName}
  `;
  if (existing.length !== 0) throw new Error('managed runtime role already exists');

  for (const statement of managedRuntimeBootstrapStatements(options)) {
    await sql.unsafe(statement);
  }

  const [role] = await sql`
    select r.rolcanlogin as "canLogin",
           r.rolsuper as "superuser",
           r.rolcreatedb as "createDatabase",
           r.rolcreaterole as "createRole",
           r.rolinherit as "inherit",
           r.rolreplication as "replication",
           r.rolbypassrls as "bypassRls",
           has_database_privilege(r.rolname, current_database(), 'CONNECT') as "canConnect",
           has_schema_privilege(r.rolname, 'public', 'USAGE') as "schemaUsage",
           has_schema_privilege(r.rolname, 'public', 'CREATE') as "schemaCreate",
           pg_has_role(r.rolname, 'eden3_erasure_operator', 'member') as "erasureOperator",
           pg_has_role(r.rolname, 'eden3_erasure_guard', 'member') as "erasureGuard",
           pg_has_role(r.rolname, 'eden3_erasure_terminal_writer', 'member') as "terminalWriter"
    from pg_roles r where r.rolname=${options.roleName}
  ` as readonly [{
    canLogin: boolean;
    superuser: boolean;
    createDatabase: boolean;
    createRole: boolean;
    inherit: boolean;
    replication: boolean;
    bypassRls: boolean;
    canConnect: boolean;
    schemaUsage: boolean;
    schemaCreate: boolean;
    erasureOperator: boolean;
    erasureGuard: boolean;
    terminalWriter: boolean;
  }];
  const [counts] = await sql`
    select count(*) filter (where c.relkind in ('r','p')
      and has_table_privilege(${options.roleName}, c.oid, 'SELECT')
      and has_table_privilege(${options.roleName}, c.oid, 'INSERT')
      and has_table_privilege(${options.roleName}, c.oid, 'UPDATE')
      and has_table_privilege(${options.roleName}, c.oid, 'DELETE'))::int as "tableCount",
      count(*) filter (where c.relkind='S'
        and has_sequence_privilege(${options.roleName}, c.oid, 'USAGE')
        and has_sequence_privilege(${options.roleName}, c.oid, 'SELECT'))::int as "sequenceCount"
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public'
  ` as readonly [{ tableCount: number; sequenceCount: number }];
  if (
    !role?.canLogin || role.superuser || role.createDatabase || role.createRole || role.inherit ||
    role.replication || role.bypassRls || !role.canConnect || !role.schemaUsage || role.schemaCreate ||
    role.erasureOperator || role.erasureGuard || role.terminalWriter ||
    !Number.isSafeInteger(counts?.tableCount) || counts.tableCount < 1 ||
    !Number.isSafeInteger(counts?.sequenceCount)
  ) {
    throw new Error('managed runtime role did not meet the least-privilege contract');
  }
  return {
    databaseName: options.databaseName,
    roleSha256: createHash('sha256').update(options.roleName).digest('hex'),
    tableCount: counts.tableCount,
    sequenceCount: counts.sequenceCount,
    statementTimeout: '30s',
    lockTimeout: '5s',
    idleInTransactionTimeout: '15s',
  };
}
