import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const CLIENT = fileURLToPath(
  new URL('../../../infra/openclaw/eden-channel-secret-resolver.mjs', import.meta.url),
);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runClient(socketPath: string, input: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLIENT, '--socket', socketPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function socketFixture(
  reply: string,
): Promise<{ socketPath: string; server: net.Server; received: Promise<string> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'eden-channel-resolver-'));
  tempDirs.push(dir);
  const socketPath = path.join(dir, 'resolver.sock');
  let receive!: (value: string) => void;
  const received = new Promise<string>((resolve) => (receive = resolve));
  const server = net.createServer((socket) => {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      input += chunk;
      if (!input.includes('\n')) return;
      receive(input.trimEnd());
      socket.end(reply);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return { socketPath, server, received };
}

describe('eden-channel-secret-resolver exec client', () => {
  it('relays one JSON-only request and whitelists the response shape', async () => {
    const token = 'runtime-only-secret';
    const fixture = await socketFixture(
      JSON.stringify({
        protocolVersion: 1,
        values: { 'channel/connection-id': token },
        ignoredDiagnostic: 'must-not-pass',
      }),
    );
    const request = JSON.stringify({
      protocolVersion: 1,
      provider: 'eden-channel-vault',
      ids: ['channel/connection-id'],
    });
    try {
      const result = await runClient(fixture.socketPath, request);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        protocolVersion: 1,
        values: { 'channel/connection-id': token },
      });
      expect(result.stdout).not.toContain('ignoredDiagnostic');
      expect(result.stderr).toBe('');
      await expect(fixture.received).resolves.toBe(request);
    } finally {
      await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    }
  });

  it('fails closed on malformed sidecar output without printing it', async () => {
    const fixture = await socketFixture('not-json secret-that-must-not-leak');
    try {
      const result = await runClient(fixture.socketPath, '{}');
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('channel secret resolver unavailable\n');
      expect(result.stderr).not.toContain('secret-that-must-not-leak');
    } finally {
      await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    }
  });

  it('rejects oversized stdin before contacting the socket', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'eden-channel-resolver-'));
    tempDirs.push(dir);
    const result = await runClient(path.join(dir, 'missing.sock'), 'x'.repeat(262_145));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('channel secret resolver unavailable\n');
  });

  it('reports socket failure generically', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'eden-channel-resolver-'));
    tempDirs.push(dir);
    const result = await runClient(path.join(dir, 'missing.sock'), '{}');
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('channel secret resolver unavailable\n');
    expect(result.stderr).not.toContain(dir);
  });
});
