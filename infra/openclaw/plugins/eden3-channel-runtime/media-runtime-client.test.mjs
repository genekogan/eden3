import assert from 'node:assert/strict';
import test from 'node:test';

import { createMediaRuntimeClient, MediaRuntimeClientError } from './media-runtime-client.js';

const AUTHORIZATION_ID = '11111111-1111-4111-8111-111111111111';

test('media callbacks permit only the production and exact Gate 3 private relay origins', () => {
  const options = { bearer: 'a-valid-test-bearer', fetchFn: async () => new Response() };
  assert.doesNotThrow(() =>
    createMediaRuntimeClient({ ...options, baseUrl: 'http://host.docker.internal:4312' }),
  );
  assert.doesNotThrow(() =>
    createMediaRuntimeClient({ ...options, baseUrl: 'http://host.docker.internal:14343' }),
  );
  assert.doesNotThrow(() =>
    createMediaRuntimeClient({
      ...options,
      baseUrl: 'http://host.docker.internal:4531',
      env: { EDEN3_RUNTIME_CALLBACK_MODE: 'isolated-harness' },
    }),
  );
  assert.throws(
    () => createMediaRuntimeClient({ ...options, baseUrl: 'http://host.docker.internal:4531' }),
    (error) => error instanceof MediaRuntimeClientError && error.code === 'invalid_runtime_url',
  );
  for (const baseUrl of [
    'http://host.docker.internal:4301',
    'http://host.docker.internal:14344',
    'https://host.docker.internal:4312',
    'http://127.0.0.1:4312',
    'http://localhost:4312',
    'http://user:pass@host.docker.internal:4312',
    'http://host.docker.internal:4312/path',
    'http://host.docker.internal:4312/?redirect=public.example',
  ]) {
    assert.throws(
      () => createMediaRuntimeClient({ ...options, baseUrl }),
      (error) =>
        error instanceof MediaRuntimeClientError && error.code === 'invalid_runtime_url',
    );
  }
});

test('media callback client sends only exact authorization paths to the relay', async () => {
  const urls = [];
  const client = createMediaRuntimeClient({
    bearer: 'a-valid-test-bearer',
    fetchFn: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  await client.post('/media/runtime/authorizations', {});
  await client.post(`/media/runtime/authorizations/${AUTHORIZATION_ID}/fail`, {});
  assert.deepEqual(urls, [
    'http://host.docker.internal:4312/media/runtime/authorizations',
    `http://host.docker.internal:4312/media/runtime/authorizations/${AUTHORIZATION_ID}/fail`,
  ]);
  await assert.rejects(
    client.post('/media/runtime/authorizations/not-a-uuid/fail', {}),
    (error) => error instanceof MediaRuntimeClientError && error.code === 'invalid_runtime_path',
  );
});
