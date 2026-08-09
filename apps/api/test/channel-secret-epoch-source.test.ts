import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROUTES = fileURLToPath(new URL('../src/routes/channels.ts', import.meta.url));
const REFERENCE = fileURLToPath(new URL('../src/services/channel-secret-resolver.ts', import.meta.url));
const DEPLOYED = fileURLToPath(
  new URL('../../../infra/channel-secret-resolver/server.mjs', import.meta.url),
);

describe('channel SecretRef durable epoch wiring', () => {
  it('advances only in the encrypted-token rotation statement and republishes the returned epoch', async () => {
    const source = await readFile(ROUTES, 'utf8');
    expect(source).toContain('capability_epoch');
    expect(source).toContain('capability_epoch = capability_epoch + 1');
    const start = source.indexOf("app.post('/connections/:id/retry'");
    const end = source.indexOf("app.get('/connections/:id/destinations'");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const rotation = source.slice(start, end);
    expect(rotation).toContain('encrypted\n              ? tx`');
    expect(rotation).toContain('capability_epoch = capability_epoch + 1');
    expect(rotation).toContain('capabilityEpoch: capabilityEpochId(fresh.capability_epoch)');
    expect(rotation).not.toMatch(/metadata[^\n]*capabilityEpoch|capabilityEpoch[^\n]*metadata/);
  });

  it('makes both resolvers verify the dedicated row column instead of a constant or metadata', async () => {
    const [reference, deployed] = await Promise.all([
      readFile(REFERENCE, 'utf8'),
      readFile(DEPLOYED, 'utf8'),
    ]);
    expect(reference).toContain('capability_epoch');
    expect(reference).toContain('capabilityEpoch: capabilityEpochId(row.capability_epoch)');
    expect(reference).not.toContain('CAPABILITY_EPOCH_DEFAULT');
    expect(deployed).toContain('c.capability_epoch');
    expect(deployed).toContain('epoch: capabilityEpochId(row.capability_epoch)');
    expect(deployed).not.toContain('const rowEpoch = () => CAPABILITY_EPOCH_DEFAULT');
    for (const source of [reference, deployed]) {
      expect(source).not.toMatch(/metadata[^\n]*capability_epoch|capability_epoch[^\n]*metadata/i);
      expect(source).not.toMatch(/token_sha256[^\n]*capability_epoch|capability_epoch[^\n]*token_sha256/i);
    }
  });
});
