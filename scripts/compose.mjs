#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const name of ['.env.local', '.env']) {
  const candidate = path.join(repoRoot, name);
  if (existsSync(candidate)) process.loadEnvFile(candidate);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  throw new Error('usage: node scripts/compose.mjs <docker compose arguments>');
}

const child = spawn('docker', ['compose', '-f', 'infra/docker-compose.yml', ...args], {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error(error instanceof Error ? error.message : 'docker compose failed');
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`docker compose exited via ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
