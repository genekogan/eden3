#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const result = spawnSync(
  'pnpm',
  [
    '--filter',
    '@eden3/api',
    'exec',
    'vitest',
    'run',
    'test/route-auth-inventory.test.ts',
    '--reporter=verbose',
  ],
  {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
