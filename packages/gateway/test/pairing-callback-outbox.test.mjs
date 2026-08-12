import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createDurablePairingCallbackOutbox,
} from '../../../infra/openclaw/plugins/eden3-channel-runtime/pairing-callback-outbox.js';

const FIRST = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  runtimeAccountId: 'account-a',
  channel: 'discord',
  agentId: 'agent-a',
  peerId: '963544662646354001',
  code: 'private-code-one',
  expiresAt: 1_800_000_600_000,
};

function withScratchOutbox(run) {
  const directory = mkdtempSync(join(tmpdir(), 'eden3-pairing-outbox-'));
  const filePath = join(directory, 'state.json');
  try {
    return run({ directory, filePath });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('encrypted channel pairing callback outbox', () => {
  it('persists only ciphertext at mode 0600 and atomically replaces one peer code', () => {
    withScratchOutbox(({ filePath }) => {
      const outbox = createDurablePairingCallbackOutbox({
        filePath,
        secret: 'synthetic-gateway-token-for-outbox-tests',
      });
      outbox.record(FIRST);
      outbox.record({ ...FIRST, code: 'private-code-two', expiresAt: FIRST.expiresAt + 1 });

      const raw = readFileSync(filePath, 'utf8');
      expect(raw).not.toContain(FIRST.peerId);
      expect(raw).not.toContain('private-code-one');
      expect(raw).not.toContain('private-code-two');
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect(outbox.list()).toEqual([
        { ...FIRST, code: 'private-code-two', expiresAt: FIRST.expiresAt + 1 },
      ]);
    });
  });

  it('fails closed under the wrong key, ciphertext tampering, and unsafe marker shapes', () => {
    withScratchOutbox(({ filePath }) => {
      const outbox = createDurablePairingCallbackOutbox({
        filePath,
        secret: 'synthetic-gateway-token-for-outbox-tests',
      });
      outbox.record(FIRST);
      expect(() =>
        createDurablePairingCallbackOutbox({
          filePath,
          secret: 'different-synthetic-gateway-token',
        }),
      ).toThrow(/invalid encrypted channel pairing callback outbox/);

      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      parsed.entries[0].ciphertext = `${parsed.entries[0].ciphertext.slice(0, -2)}AA`;
      writeFileSync(filePath, JSON.stringify(parsed), { mode: 0o600 });
      expect(() =>
        createDurablePairingCallbackOutbox({
          filePath,
          secret: 'synthetic-gateway-token-for-outbox-tests',
        }),
      ).toThrow(/invalid encrypted channel pairing callback outbox/);

      expect(() => outbox.record({ ...FIRST, peerId: '../../peer' })).toThrow(
        /invalid channel pairing callback marker/,
      );
      expect(() => outbox.record({ ...FIRST, code: 'x'.repeat(129) })).toThrow(
        /invalid channel pairing callback marker/,
      );
    });
  });

  it('requires the existing gateway secret before any file mutation', () => {
    withScratchOutbox(({ filePath }) => {
      expect(() => createDurablePairingCallbackOutbox({ filePath, secret: '' })).toThrow(
        /encryption unavailable/,
      );
      expect(() => readFileSync(filePath, 'utf8')).toThrow();
    });
  });
});
