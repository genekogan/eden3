import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createEdenDiscordDrainTracker } from '../../../infra/openclaw/discord-reconnect-drain.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('Discord reconnect-retention guard', () => {
  it('drains every admitted generation before replacement and rejects late admissions', async () => {
    const generations = [];
    const releases = [];

    for (let index = 0; index < 30; index += 1) {
      const tracker = createEdenDiscordDrainTracker();
      const admission = tracker.reserve();
      const release = deferred();
      expect(admission).not.toBeNull();
      void release.promise.finally(() => admission.settle());
      tracker.stopAccepting();
      generations.push({ tracker, drain: tracker.drain() });
      releases.push(release);
    }

    expect(generations.every(({ tracker }) => tracker.pendingCount() === 1)).toBe(true);
    expect(generations.every(({ tracker }) => tracker.reserve() === null)).toBe(true);

    for (const release of releases) release.resolve();
    await Promise.all(generations.map(({ drain }) => drain));

    expect(generations.every(({ tracker }) => tracker.pendingCount() === 0)).toBe(true);
  });

  it('patches only the pinned Discord handler/provider bundles and makes teardown await drain', async () => {
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eden3-discord-drain-'));
    await fs.writeFile(
      path.join(fixtureDir, 'message-handler-pinned.js'),
      await fs.readFile(
        path.join(REPO_ROOT, 'infra/openclaw/fixtures/message-handler-reconnect-pinned.js'),
        'utf8',
      ),
    );
    await fs.writeFile(
      path.join(fixtureDir, 'provider-pinned.js'),
      await fs.readFile(
        path.join(REPO_ROOT, 'infra/openclaw/fixtures/provider-reconnect-pinned.js'),
        'utf8',
      ),
    );

    try {
      const child = spawn(
        process.execPath,
        [path.join(REPO_ROOT, 'infra/openclaw/patch-discord-reconnect-retention.mjs')],
        {
          env: { ...process.env, OPENCLAW_DIST_DIR: fixtureDir },
          stdio: 'pipe',
        },
      );
      let error = '';
      child.stderr.on('data', (chunk) => {
        error += String(chunk);
      });
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      expect(code, error).toBe(0);

      const handler = await fs.readFile(path.join(fixtureDir, 'message-handler-pinned.js'), 'utf8');
      const provider = await fs.readFile(path.join(fixtureDir, 'provider-pinned.js'), 'utf8');
      expect(handler).toContain('const pendingTasks = createEdenDiscordDrainTracker();');
      expect(handler).toContain('await pendingTasks.drain();');
      expect(handler).toContain('const activeAdmissions = createEdenDiscordDrainTracker();');
      expect(handler).toContain('await activeAdmissions.drain();');
      expect(provider).toContain('async function cleanupDiscordProviderStartup(params)');
      expect(provider).toContain('await params.deactivateMessageHandler?.();');
      expect(provider).toContain('await cleanupDiscordProviderStartup({');
    } finally {
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
