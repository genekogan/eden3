import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createChannelRuntimeClient,
  ChannelRuntimeClientError,
} from './runtime-client.js';
import {
  createMediaRuntimeClient,
  MediaRuntimeClientError,
} from './media-runtime-client.js';

const exactOptions = {
  bearer: 'a-valid-test-bearer',
  fetchFn: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
};

test('both runtime clients admit an exact isolated callback only in harness mode', () => {
  for (const createClient of [createChannelRuntimeClient, createMediaRuntimeClient]) {
    assert.doesNotThrow(() => createClient({
      ...exactOptions,
      baseUrl: 'http://host.docker.internal:4531',
      env: { EDEN3_RUNTIME_CALLBACK_MODE: 'isolated-harness' },
    }));
    assert.throws(
      () => createClient({ ...exactOptions, baseUrl: 'http://host.docker.internal:4531', env: {} }),
      (error) =>
        (error instanceof ChannelRuntimeClientError || error instanceof MediaRuntimeClientError) &&
        error.code === 'invalid_runtime_url',
    );
  }
});

test('isolated harness mode remains exact and cannot broaden callback authority', () => {
  const env = { EDEN3_RUNTIME_CALLBACK_MODE: 'isolated-harness' };
  for (const baseUrl of [
    'https://host.docker.internal:4531',
    'http://127.0.0.1:4531',
    'http://localhost:4531',
    'http://user@host.docker.internal:4531',
    'http://host.docker.internal:4531/path',
    'http://host.docker.internal:4531?query=1',
    'http://host.docker.internal:4531#fragment',
    'http://host.docker.internal:4301',
    'http://host.docker.internal:18789',
    'http://host.docker.internal:080',
  ]) {
    for (const createClient of [createChannelRuntimeClient, createMediaRuntimeClient]) {
      assert.throws(
        () => createClient({ ...exactOptions, baseUrl, env }),
        (error) =>
          (error instanceof ChannelRuntimeClientError || error instanceof MediaRuntimeClientError) &&
          error.code === 'invalid_runtime_url',
      );
    }
  }
});

test('Gate 3 overlay ships the shared authority and both callback clients', () => {
  const overlay = readFileSync(
    new URL('../../Dockerfile.gate3-overlay', import.meta.url),
    'utf8',
  );
  for (const file of [
    'runtime-callback-authority.js',
    'runtime-client.js',
    'media-runtime-client.js',
  ]) {
    assert.equal(
      overlay
        .split(/\r?\n/)
        .filter((line) => line.includes(`COPY --chown=node:node plugins/eden3-channel-runtime/${file} `))
        .length,
      1,
    );
  }
});
