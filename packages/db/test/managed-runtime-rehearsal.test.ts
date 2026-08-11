import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { latencySummary } from '../src/managed-runtime-rehearsal';

describe('managed PostgreSQL runtime connection rehearsal', () => {
  it('summarizes latency deterministically without averaging away a tail', () => {
    expect(latencySummary([1, 2, 3, 4, 5, 100])).toEqual({ p50: 3, p95: 100, max: 100 });
    expect(() => latencySummary([])).toThrow(/invalid/);
    expect(() => latencySummary([1, -1])).toThrow(/invalid/);
  });

  it('pins bounded load, exact runtime authority, self-backend termination, and safe output', async () => {
    const source = await readFile(new URL('../src/managed-runtime-rehearsal.ts', import.meta.url), 'utf8');
    const cli = await readFile(new URL('../src/managed-runtime-rehearsal-cli.ts', import.meta.url), 'utf8');
    expect(source).toContain('const STEADY_WORKERS = 10');
    expect(source).toContain('const BURST_REQUESTS = 50');
    expect(source).toContain('await recovery`select pg_terminate_backend(pg_backend_pid()) as terminated`');
    expect(source).toContain('recoveredPid === before.backendPid');
    expect(source).toContain("const RUNTIME_ROLE = /^eden3_runtime_");
    expect(source).toContain("ssl: 'verify-full'");
    expect(cli).toContain("error: 'managed_runtime_rehearsal_failed'");
    expect(cli).not.toMatch(/console\.(?:log|error)\([^\n]*(?:databaseUrl|password|host)/);
  });
});
