import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assertMatchingDatabaseSelection } from '../../../infra/channel-secret-resolver/server.mjs';
import { deriveRequesterKey } from '../../../infra/channel-secret-resolver/server.mjs';
import { deriveComposeChannelRequesterKey } from '../../../scripts/compose.mjs';

const INFRA = fileURLToPath(new URL('../../../infra/', import.meta.url));

function serviceBlock(compose, name) {
  const lines = compose.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) throw new Error(`missing service ${name}`);
  const end = lines.findIndex((line, index) => index > start && /^  [a-zA-Z0-9_-]+:$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

describe('channel resolver infrastructure contract', () => {
  it('keeps database and AES credentials out of OpenClaw', async () => {
    const compose = await readFile(`${INFRA}docker-compose.yml`, 'utf8');
    const openclaw = serviceBlock(compose, 'openclaw');
    const resolver = serviceBlock(compose, 'channel-secret-resolver');

    expect(resolver).toContain(
      'DATABASE_URL: "postgres://eden3:eden3@postgres:5432/${EDEN3_DATABASE_NAME:?',
    );
    expect(resolver).toContain(
      'EDEN3_API_DATABASE_URL: "${EDEN3_COMPOSE_API_DATABASE_URL:?',
    );
    expect(resolver).not.toContain('EDEN3_DATABASE_NAME:-eden3');
    expect(resolver).not.toContain('CHANNEL_RESOLVER_DATABASE_URL');
    expect(resolver).toContain('CHANNEL_TOKEN_ENCRYPTION_KEY: ${CHANNEL_TOKEN_ENCRYPTION_KEY');
    expect(resolver).toContain('channel_secret_socket:/run/eden3');
    expect(resolver).toContain('- channel_secret_db');
    expect(resolver).toContain('read_only: true');
    expect(resolver).toContain('- no-new-privileges:true');
    expect(openclaw).toContain('channel_secret_socket:/run/eden3:ro');
    expect(openclaw).toContain('- openclaw_runtime');
    expect(openclaw).not.toContain('- channel_secret_db');
    expect(openclaw).not.toContain('DATABASE_URL:');
    expect(openclaw).not.toContain('CHANNEL_TOKEN_ENCRYPTION_KEY:');
    expect(openclaw).toContain('EDEN_CHANNEL_REQUESTER_KEY:');
    expect(compose).toMatch(/channel_secret_db:\n\s+internal: true/);
  });

  it('derives the same requester key at compose and resolver boundaries', () => {
    const vaultKey = Buffer.alloc(32, 0x5a);
    expect(Buffer.from(deriveComposeChannelRequesterKey(vaultKey.toString('base64')), 'base64')).toEqual(
      deriveRequesterKey(vaultKey),
    );
  });

  it('linearizes grants with lifecycle writes and excludes API-only X credentials', async () => {
    const server = await readFile(`${INFRA}channel-secret-resolver/server.mjs`, 'utf8');
    expect(server).toContain('sql.begin((tx) =>');
    expect(server).toContain("join agents a on a.account_id = c.agent_id");
    expect(server).toContain("and c.channel in ('discord', 'telegram')");
    expect(server).toContain('for share of c, a, agent_account, owner');
    expect(server).toContain('processInstanceId: event.processInstanceId');
    expect(server).not.toContain("and c.channel in ('discord', 'telegram', 'x')");
  });

  it('fails closed if its logical database differs from the API selection', () => {
    expect(
      assertMatchingDatabaseSelection(
        'postgres://sidecar@postgres:5432/eden3_stg',
        'postgres://api@localhost:5433/eden3_stg',
      ),
    ).toBe('eden3_stg');
    expect(() =>
      assertMatchingDatabaseSelection(
        'postgres://sidecar@postgres:5432/eden3',
        'postgres://api@localhost:5433/eden3_stg',
      ),
    ).toThrow(/does not match the API/);
    expect(() =>
      assertMatchingDatabaseSelection(
        'postgres://sidecar@postgres:5432/scratch/%2e%2e/eden3',
        'postgres://api@localhost:5433/eden3',
      ),
    ).toThrow(/does not match the API/);
    expect(() =>
      assertMatchingDatabaseSelection(
        'postgres://sidecar@postgres:5432/%65den3',
        'postgres://api@localhost:5433/eden3',
      ),
    ).toThrow(/does not match the API/);
  });

  it('keeps cold-boot health and host Postgres routing compatible with the hardened socket', async () => {
    const [compose, server] = await Promise.all([
      readFile(`${INFRA}docker-compose.yml`, 'utf8'),
      readFile(`${INFRA}channel-secret-resolver/server.mjs`, 'utf8'),
    ]);
    const postgres = serviceBlock(compose, 'postgres');
    const resolver = serviceBlock(compose, 'channel-secret-resolver');

    // Colima does not publish the loopback port for a container connected only
    // to internal networks. The default bridge must remain alongside the two
    // least-privilege sidecar networks after every cold recreation.
    expect(postgres).toContain('default: {}');
    expect(postgres).toContain('channel_secret_db: {}');
    expect(postgres).toContain('agent_cron_db: {}');
    expect(postgres).toContain('127.0.0.1:5433:5432');

    // The health process is capability-dropped root while the listener is uid
    // 1000 with mode 0660, so connecting is intentionally impossible. Socket
    // existence proves startup without weakening its access boundary.
    expect(resolver).toContain('test: ["CMD", "test", "-S", "/run/eden3/channel-secrets.sock"]');
    expect(resolver).toContain('- ALL');
    expect(server).toContain('await chown(path.dirname(socketPath), 1000, 1000)');
    expect(server).toContain('process.setgid(1000)');
    expect(server).toContain('process.setuid(1000)');
    expect(server).toContain('await chmod(socketPath, 0o660)');
  });

  it('installs only the bounded exec client in the OpenClaw image', async () => {
    const [dockerfile, client] = await Promise.all([
      readFile(`${INFRA}openclaw/Dockerfile`, 'utf8'),
      readFile(`${INFRA}openclaw/eden-channel-secret-resolver.mjs`, 'utf8'),
    ]);
    expect(dockerfile).toContain(
      'COPY --chown=node:node eden-channel-secret-resolver.mjs /usr/local/bin/eden-channel-secret-resolver',
    );
    expect(dockerfile).toContain('/usr/local/bin/eden-channel-secret-resolver');
    expect(dockerfile).not.toContain('channel-secret-resolver/server.mjs');
    // OpenClaw intentionally scrubs PATH for exec SecretRefs. The image's
    // pinned Node binary lives in /usr/local/bin, so env(1) cannot resolve it.
    expect(client).toMatch(/^#!\/usr\/local\/bin\/node\n/);
  });
});
