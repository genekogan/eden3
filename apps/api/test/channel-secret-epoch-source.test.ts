import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROUTES = fileURLToPath(new URL('../src/routes/channels.ts', import.meta.url));
const REFERENCE = fileURLToPath(new URL('../src/services/channel-secret-resolver.ts', import.meta.url));
const DEPLOYED = fileURLToPath(
  new URL('../../../infra/channel-secret-resolver/server.mjs', import.meta.url),
);
const DEBT = fileURLToPath(new URL('../../../orchestration/DEBT.md', import.meta.url));
const INTERFACES = fileURLToPath(new URL('../../../orchestration/INTERFACES.md', import.meta.url));
const LEDGER = fileURLToPath(new URL('../../../orchestration/LEDGER.md', import.meta.url));

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
    expect(rotation).toContain(
      "app.post('/connections/:id/retry', { preHandler: app.requireAuth }, lifecycleHandler(async",
    );
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

  it('keeps the normative residual ledger honest about rotation and shared-gateway debt', async () => {
    const [debt, interfaces, ledger] = await Promise.all([
      readFile(DEBT, 'utf8'),
      readFile(INTERFACES, 'utf8'),
      readFile(LEDGER, 'utf8'),
    ]);
    expect(debt).toContain('Each credential rotation atomically advances a dedicated bounded');
    expect(debt).toContain('shared-gateway estate reach');
    expect(debt).not.toContain('Rotation currently keeps epoch `c1`');
    expect(debt).not.toContain('a real monotonic epoch/token-rotation remint remain');
    expect(interfaces).toContain(
      '["eden3-channel-cap-v1", connectionId, accountId, channel, runtimeAccountId, epoch]',
    );
    expect(interfaces).toContain('Per-credential rotation now advances a dedicated monotonic epoch');
    expect(interfaces).not.toContain('hard-coded capability epoch');
    expect(interfaces).not.toContain('Capability epoch is still `c1`');
    expect(ledger).toContain('2026-08-09 retained-M3 amendment');
    expect(ledger).toContain('D-005 shared-gateway requester isolation remains open');
  });
});
