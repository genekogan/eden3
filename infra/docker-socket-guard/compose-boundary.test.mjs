import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const composePath = path.resolve(here, '..', 'docker-compose.yml');

function serviceBlock(compose, service) {
  const startPattern = new RegExp(`^  ${service}:\\s*$`, 'm');
  const match = startPattern.exec(compose);
  assert.ok(match, `missing ${service} service`);
  const start = match.index;
  const tail = compose.slice(start + match[0].length);
  const next = /^  [a-zA-Z0-9_-]+:\s*$/m.exec(tail);
  return compose.slice(start, next ? start + match[0].length + next.index : compose.length);
}

test('only the unexposed sandbox guard receives the raw Docker socket', async () => {
  const compose = await readFile(composePath, 'utf8');
  const services = compose.split(/^volumes:\s*$/m, 1)[0];
  const guard = serviceBlock(services, 'sandbox-docker-guard');
  const openclaw = serviceBlock(services, 'openclaw');

  assert.match(guard, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.match(guard, /\$\{PWD\}\/infra\/openclaw\/data:\$\{PWD\}\/infra\/openclaw\/data:rw/);
  assert.match(guard, /\$\{PWD\}\/assets\/sandbox:\$\{PWD\}\/assets\/sandbox:ro/);
  assert.doesNotMatch(openclaw, /\/var\/run\/docker\.sock/);
  assert.match(openclaw, /DOCKER_HOST:\s*tcp:\/\/sandbox-docker-guard:2375/);
  assert.doesNotMatch(guard, /^    ports:\s*$/m);
  assert.match(guard, /^    read_only:\s*true\s*$/m);
  assert.match(guard, /^    cap_drop:\s*\n      - ALL\s*$/m);
  assert.match(guard, /^    security_opt:\s*\n      - no-new-privileges:true\s*$/m);
});

test('the Docker-control network is internal and excludes credential sidecars', async () => {
  const compose = await readFile(composePath, 'utf8');
  const guard = serviceBlock(compose, 'sandbox-docker-guard');
  const openclaw = serviceBlock(compose, 'openclaw');
  const resolver = serviceBlock(compose, 'channel-secret-resolver');

  assert.match(guard, /\n    networks:\n      - sandbox_control\n/);
  assert.match(openclaw, /\n      - sandbox_control\n/);
  assert.doesNotMatch(resolver, /sandbox_control/);
  assert.match(compose, /\n  sandbox_control:\n    internal: true\n/);
});
