import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMediaAuthorizationBridge } from './media-authorization.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const context = {
  runId: 'run-a',
  toolCallId: 'call-a',
  sessionKey: 'agent:agent-a:eden3:s:11111111-1111-4111-8111-111111111112',
  agentId: 'agent-a',
};

test('before_tool_call denies provider execution when authorization fails', async () => {
  const bridge = createMediaAuthorizationBridge({
    client: { post: async () => { throw new Error('denied'); } },
  });
  const result = await bridge.onBeforeToolCall(
    { toolName: 'video_generate', params: { prompt: 'x' }, ...context },
    context,
  );
  assert.equal(result?.block, true);
});

test('authorization failures expose stable Eden causes instead of inventing a provider outage', async () => {
  for (const [code, expected] of [
    ['insufficient_manna', 'Eden needs more manna for this media request.'],
    ['daily_cap', 'Eden paused this media request to protect the account manna budget.'],
    ['session_agent_binding', 'This conversation is no longer authorized to generate media with this agent.'],
  ]) {
    const error = new Error('safe internal failure');
    error.code = code;
    const bridge = createMediaAuthorizationBridge({
      client: { post: async () => { throw error; } },
    });
    const result = await bridge.onBeforeToolCall(
      { toolName: 'image_generate', params: { prompt: 'x' }, ...context },
      context,
    );
    assert.deepEqual(result, { block: true, blockReason: expected });
  }
});

test('successful authorization passes without exposing bearer/capability material', async () => {
  const requests = [];
  const bridge = createMediaAuthorizationBridge({
    client: {
      post: async (path, body) => {
        requests.push({ path, body });
        return {
          ok: true,
          authorizationOwner: 'chat',
          authorizationId: UUID,
          authorizedMaxManna: 608,
          tool: 'video_generate',
          providerArgs: { prompt: 'x', durationSeconds: 5, model: 'fal/video' },
        };
      },
    },
  });
  const result = await bridge.onBeforeToolCall(
    { toolName: 'video_generate', params: { prompt: 'x' }, ...context },
    context,
  );
  assert.deepEqual(result, {
    params: { prompt: 'x', durationSeconds: 5, model: 'fal/video' },
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(requests[0].body).sort(), [
    'agentId',
    'args',
    'runId',
    'sessionKey',
    'tool',
    'toolCallId',
  ]);
  assert.equal(JSON.stringify(requests).includes('Bearer '), false);
});

test('image-to-video admits only a generated image inside the configured OpenClaw state root', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'eden3-video-reference-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const mediaDir = path.join(stateDir, 'media', 'tool-image-generation');
  await mkdir(mediaDir, { recursive: true });
  await mkdir(path.join(stateDir, 'workspace-agent-a'));
  const image = path.join(mediaDir, 'image-1---bunny.png');
  await writeFile(
    image,
    Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      Buffer.from('bounded fake image bytes'),
    ]),
  );
  const requests = [];
  const bridge = createMediaAuthorizationBridge({
    stateDir,
    client: {
      post: async (requestPath, body) => {
        requests.push({ requestPath, body });
        return {
          ok: true,
          authorizationOwner: 'chat',
          authorizationId: UUID,
          authorizedMaxManna: 500,
          tool: 'video_generate',
          providerArgs: {
            prompt: 'hop',
            image,
            durationSeconds: 4,
            model: 'fal/fal-ai/kling-video/v3/pro/image-to-video',
          },
        };
      },
    },
  });

  const admitted = await bridge.onBeforeToolCall(
    { toolName: 'video_generate', params: { prompt: 'hop', image }, ...context },
    context,
  );
  assert.equal(admitted.params.prompt, 'hop');
  assert.equal(admitted.params.durationSeconds, 4);
  assert.equal(admitted.params.model, 'fal/fal-ai/kling-video/v3/pro/image-to-video');
  assert.match(admitted.params.image, /^.*\/workspace-agent-a\/\.eden-video-input-[a-f0-9-]+\.png$/);
  assert.equal((await stat(admitted.params.image)).isFile(), true);
  await bridge.onAfterToolCall(
    { toolName: 'video_generate', ...context, result: { ok: true } },
    context,
  );
  await assert.rejects(stat(admitted.params.image), { code: 'ENOENT' });
  assert.equal(requests[0].body.args.image, image);

  for (const unsafe of [
    '/etc/passwd',
    path.join(stateDir, 'media', 'secrets.png'),
    path.join(path.dirname(stateDir), 'other', 'media', 'tool-image-generation', 'private.png'),
  ]) {
    const denied = await bridge.onBeforeToolCall(
      {
        toolName: 'video_generate',
        params: { prompt: 'hop', image: unsafe },
        ...context,
        toolCallId: `unsafe-${unsafe.length}`,
      },
      { ...context, toolCallId: `unsafe-${unsafe.length}` },
    );
    assert.equal(denied?.block, true);
  }
  assert.equal(requests.length, 1);

  await rm(path.join(stateDir, 'workspace-agent-a'), { recursive: true });
  await mkdir(path.join(stateDir, 'workspace-agent-b'));
  await symlink('workspace-agent-b', path.join(stateDir, 'workspace-agent-a'), 'dir');
  const reboundWorkspace = await bridge.onBeforeToolCall(
    { toolName: 'video_generate', params: { prompt: 'hop', image }, ...context },
    context,
  );
  assert.equal(reboundWorkspace.block, true);
  assert.equal(requests.length, 1);
});

test('duplicate same-process tool admission is denied before a second provider run', async () => {
  let calls = 0;
  const bridge = createMediaAuthorizationBridge({
    client: {
      post: async () => {
        calls += 1;
        return {
          ok: true,
          authorizationOwner: 'chat',
          authorizationId: UUID,
          authorizedMaxManna: 608,
          tool: 'video_generate',
          providerArgs: { prompt: 'x', durationSeconds: 5, model: 'fal/video' },
        };
      },
    },
  });
  assert.deepEqual(
    await bridge.onBeforeToolCall(
      { toolName: 'video_generate', params: { prompt: 'x' }, ...context },
      context,
    ),
    { params: { prompt: 'x', durationSeconds: 5, model: 'fal/video' } },
  );
  const duplicate = await bridge.onBeforeToolCall(
    { toolName: 'video_generate', params: { prompt: 'x' }, ...context },
    context,
  );
  assert.equal(duplicate?.block, true);
  assert.equal(calls, 1);
});

test('concurrent identical admissions synchronously fence the loser', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const bridge = createMediaAuthorizationBridge({
    client: {
      post: async () => {
        calls += 1;
        await gate;
        return {
          ok: true,
          authorizationOwner: 'chat',
          authorizationId: UUID,
          authorizedMaxManna: 608,
          tool: 'video_generate',
          providerArgs: { prompt: 'x', durationSeconds: 5, model: 'fal/video' },
        };
      },
    },
  });
  const first = bridge.onBeforeToolCall(
    { toolName: 'video_generate', params: { prompt: 'x' }, ...context },
    context,
  );
  const second = await bridge.onBeforeToolCall(
    { toolName: 'video_generate', params: { prompt: 'x' }, ...context },
    context,
  );
  assert.equal(second?.block, true);
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, {
    params: { prompt: 'x', durationSeconds: 5, model: 'fal/video' },
  });
});

test('after_tool_call failure requests exact idempotent compensation', async () => {
  const requests = [];
  const bridge = createMediaAuthorizationBridge({
    client: {
      post: async (path, body) => {
        requests.push({ path, body });
        if (path.endsWith('/fail')) return { ok: true };
        return {
          ok: true,
          authorizationOwner: 'chat',
          authorizationId: UUID,
          authorizedMaxManna: 34,
          tool: 'image_generate',
          providerArgs: { prompt: 'x', model: 'fal/image' },
        };
      },
    },
  });
  await bridge.onBeforeToolCall(
    { toolName: 'image_generate', params: { prompt: 'x' }, ...context },
    context,
  );
  await bridge.onAfterToolCall(
    { toolName: 'image_generate', params: { prompt: 'x' }, error: 'provider failed', ...context },
    context,
  );
  assert.equal(requests[1].path, `/media/runtime/authorizations/${UUID}/fail`);
  assert.deepEqual(requests[1].body, { errorCode: 'media_tool_failed' });
});

test('exact Studio reservation passes without chat host ids or failure ownership', async () => {
  const requests = [];
  const bridge = createMediaAuthorizationBridge({
    client: {
      post: async (requestPath, body) => {
        requests.push({ path: requestPath, body });
        return {
          ok: true,
          authorizationOwner: 'studio',
          authorizationId: UUID,
          authorizedMaxManna: 34,
          tool: 'image_generate',
          providerArgs: { prompt: 'x', model: 'fal/image' },
        };
      },
    },
  });
  const studio = {
    sessionKey: `agent:main:eden3:studio:${UUID}`,
    agentId: 'main',
  };
  assert.deepEqual(
    await bridge.onBeforeToolCall(
      { toolName: 'image_generate', params: { prompt: 'x' } },
      studio,
    ),
    { params: { prompt: 'x', model: 'fal/image' } },
  );
  assert.equal(
    (
      await bridge.onBeforeToolCall(
        { toolName: 'image_generate', params: { prompt: 'x' } },
        studio,
      )
    )?.block,
    true,
  );
  await bridge.onAfterToolCall(
    { toolName: 'image_generate', params: { prompt: 'x' }, error: 'provider failed' },
    studio,
  );
  assert.equal(requests.length, 1);
  assert.equal('runId' in requests[0].body, false);
  assert.equal('toolCallId' in requests[0].body, false);
});

test('catalog/status actions and unrelated tools spend nothing', async () => {
  let calls = 0;
  const bridge = createMediaAuthorizationBridge({
    client: { post: async () => { calls += 1; } },
  });
  assert.equal(
    await bridge.onBeforeToolCall(
      { toolName: 'image_generate', params: { action: 'status' }, ...context },
      context,
    ),
    undefined,
  );
  assert.equal(
    await bridge.onBeforeToolCall({ toolName: 'memory_search', params: {}, ...context }, context),
    undefined,
  );
  assert.equal(calls, 0);
});
