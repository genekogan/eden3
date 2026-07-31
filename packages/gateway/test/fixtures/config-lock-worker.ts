import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { mutateOpenClawConfig, withOpenClawConfigLock } from '../../src/config-gen';

function requiredArg(index: number, label: string): string {
  const value = process.argv[index];
  if (value === undefined || value === '') throw new Error(`missing ${label}`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(file: string): Promise<void> {
  while (true) {
    try {
      await access(file);
      return;
    } catch {
      await delay(5);
    }
  }
}

const mode = requiredArg(2, 'mode');
const dataDir = requiredArg(3, 'dataDir');
const syncDir = requiredArg(4, 'syncDir');
const workerId = requiredArg(5, 'workerId');
const ready = path.join(syncDir, `ready-${workerId}`);

if (mode === 'mutate') {
  await writeFile(ready, 'ready\n');
  await waitFor(path.join(syncDir, 'start'));
  await mutateOpenClawConfig(dataDir, async (config) => {
    const raw = config.concurrentWriters;
    const writers =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    config.concurrentWriters = writers;
    const observedBeforeDelay = Object.keys(writers).length;
    // Widen the stale-read window enough that an unlocked implementation loses
    // almost every peer update when all processes cross the barrier together.
    await delay(60);
    writers[workerId] = { workerId, observedBeforeDelay };
  });
} else if (mode === 'crash') {
  await withOpenClawConfigLock(dataDir, async () => {
    await writeFile(ready, 'locked\n');
    process.kill(process.pid, 'SIGKILL');
    await new Promise<never>(() => {});
  });
} else {
  throw new Error(`unknown worker mode ${JSON.stringify(mode)}`);
}
