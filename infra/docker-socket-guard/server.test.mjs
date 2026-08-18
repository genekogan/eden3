import assert from 'node:assert/strict';
import http from 'node:http';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { authorizeRequest, createGuardServer, summarizeSandboxCreateDenial } from './server.mjs';

const MIB = 1024 * 1024;
const SANDBOX_ID = '7410f39ccafe';
const SANDBOX_NAME = 'openclaw-sbx-agent-a-abcd1234';
const CREATE_URL = `/v1.47/containers/create?name=${SANDBOX_NAME}`;
const RESOLVER_ID = '0de0c0decafe';
const IMAGE = 'eden3-openclaw-sandbox-media:2026.7.1';
const NETWORK = 'eden3-sandbox-egress';
const WORKSPACE_ROOT = '/srv/eden3/openclaw-data/sandboxes';
const SENTINEL = `.eden3-mount-attestation-${'b'.repeat(32)}`;
const MOUNT_CHECK_SCRIPT = 'test -f "$1" && : > /tmp/eden3-mount-ready && exec sleep infinity';
const MOUNT_HEALTHCHECK = {
  Test: ['CMD-SHELL', 'test -f /tmp/eden3-mount-ready'],
  Interval: 1_000_000_000,
  Timeout: 2_000_000_000,
  Retries: 1,
  StartPeriod: 0,
};

const policy = Object.freeze({
  allowedImages: [IMAGE],
  allowedNetworks: [NETWORK],
  workspaceRoots: [WORKSPACE_ROOT],
  assetRoots: ['/srv/eden3/assets/sandbox'],
  maxBodyBytes: MIB,
  maxMemoryBytes: 768 * MIB,
  maxPids: 128,
  inspectSentinel: () => true,
});

function sandboxCreateBody(overrides = {}) {
  return {
    Image: IMAGE,
    Labels: {
      'openclaw.sandbox': '1',
      'openclaw.sessionKey': 'agent:agent-a:main',
      'openclaw.createdAtMs': '1786219200000',
      'openclaw.mountFormatVersion': '3',
      'openclaw.configHash': 'a'.repeat(64),
    },
    User: '',
    Cmd: ['sleep', 'infinity'],
    WorkingDir: '/workspace',
    Env: [
      'HTTP_PROXY=http://eden3-egress-proxy:8080',
      'HTTPS_PROXY=http://eden3-egress-proxy:8080',
      'http_proxy=http://eden3-egress-proxy:8080',
      'https_proxy=http://eden3-egress-proxy:8080',
      'NO_PROXY=localhost,127.0.0.1,::1',
      'no_proxy=localhost,127.0.0.1,::1',
      'OPENCLAW_CLI=1',
    ],
    HostConfig: {
      NetworkMode: NETWORK,
      Memory: 512 * MIB,
      MemorySwap: 512 * MIB,
      PidsLimit: 96,
      OomScoreAdj: 1000,
      ReadonlyRootfs: true,
      Privileged: false,
      Binds: [`${WORKSPACE_ROOT}/agent-a:/workspace:z`],
      Tmpfs: { '/tmp': '', '/var/tmp': '', '/run': '' },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
    },
    ...overrides,
  };
}

function sandboxInspect(overrides = {}) {
  const create = sandboxCreateBody();
  return {
    Id: SANDBOX_ID,
    Image: 'sha256:trusted-sandbox-image',
    Name: `/${SANDBOX_NAME}`,
    Config: {
      Image: create.Image,
      Labels: {
        'com.docker.compose.project': 'eden3',
        'com.docker.compose.service': 'openclaw-sandbox-media',
        'com.docker.compose.version': '2.34.0',
        ...create.Labels,
        'eden3.guard.mountSentinel': SENTINEL,
      },
      User: create.User,
      Cmd: ['/bin/sh', '-c', MOUNT_CHECK_SCRIPT, 'eden3-mount-check', `/workspace/${SENTINEL}`],
      WorkingDir: create.WorkingDir,
      Env: create.Env,
      Entrypoint: null,
      Healthcheck: MOUNT_HEALTHCHECK,
    },
    HostConfig: create.HostConfig,
    NetworkSettings: { Networks: { [NETWORK]: {} } },
    State: { Running: true, Health: { Status: 'healthy' } },
    Mounts: [
      {
        Type: 'bind',
        Source: `${WORKSPACE_ROOT}/agent-a`,
        Destination: '/workspace',
        RW: true,
      },
    ],
    ...overrides,
  };
}

function resolverInspect() {
  return {
    Id: RESOLVER_ID,
    Name: '/eden3-channel-secret-resolver',
    Config: {
      Image: 'eden3-channel-secret-resolver:latest',
      Labels: { 'com.docker.compose.service': 'channel-secret-resolver' },
      User: '1000:1000',
    },
    HostConfig: {
      NetworkMode: 'eden3_channel_secret_db',
      Memory: 256 * MIB,
      PidsLimit: 128,
      ReadonlyRootfs: true,
      Binds: ['eden3_channel_secret_socket:/run/eden3:rw'],
      Tmpfs: { '/tmp': '' },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
    },
  };
}

function makeLookup({
  sandbox = sandboxInspect(),
  issuedExecIds = new Map([['exec-allowed', SANDBOX_ID]]),
  execs = new Map([
    ['exec-allowed', { ID: 'exec-allowed', ContainerID: SANDBOX_ID }],
    ['exec-resolver', { ID: 'exec-resolver', ContainerID: RESOLVER_ID }],
  ]),
} = {}) {
  return {
    issuedExecIds,
    async inspectContainer(id) {
      if (id === SANDBOX_ID || id === SANDBOX_NAME) return sandbox;
      if (id === RESOLVER_ID || id === 'eden3-channel-secret-resolver') {
        return resolverInspect();
      }
      return null;
    },
    async inspectExec(id) {
      return execs.get(id) ?? null;
    },
    async inspectImage(image) {
      return image === IMAGE ? { Id: 'sha256:trusted-sandbox-image' } : null;
    },
  };
}

async function authorize(request, lookup = makeLookup()) {
  return authorizeRequest(
    {
      headers: {},
      policy,
      ...request,
    },
    lookup,
  );
}

async function expectAllowed(request, lookup) {
  const verdict = await authorize(request, lookup);
  assert.equal(verdict.allowed, true, verdict.code);
  assert.match(verdict.code, /^[a-z][a-z0-9_.-]{0,99}$/);
}

async function expectDenied(request, lookup) {
  const verdict = await authorize(request, lookup);
  assert.equal(verdict.allowed, false, verdict.code);
  assert.match(verdict.code, /^[a-z][a-z0-9_.-]{0,99}$/);
}

test('allows only a bounded, least-privileged sandbox create request', async () => {
  await expectAllowed({
    method: 'POST',
    url: CREATE_URL,
    body: sandboxCreateBody(),
  });
  await expectAllowed({
    method: 'POST',
    url: CREATE_URL,
    body: sandboxCreateBody({
      HostConfig: { ...sandboxCreateBody().HostConfig, OomScoreAdj: 0 },
    }),
  });
  await expectDenied({
    method: 'POST',
    url: CREATE_URL,
    body: sandboxCreateBody({
      HostConfig: { ...sandboxCreateBody().HostConfig, OomScoreAdj: -1000 },
    }),
  });
});

test('accepts Docker inspect omitting only the exact zero health start period', async () => {
  const omittedZeroStartPeriod = sandboxInspect();
  omittedZeroStartPeriod.Config.Healthcheck = { ...omittedZeroStartPeriod.Config.Healthcheck };
  delete omittedZeroStartPeriod.Config.Healthcheck.StartPeriod;
  await expectAllowed(
    { method: 'GET', url: `/v1.47/containers/${SANDBOX_ID}/json` },
    makeLookup({ sandbox: omittedZeroStartPeriod }),
  );

  const nonzeroStartPeriod = sandboxInspect();
  nonzeroStartPeriod.Config.Healthcheck = {
    ...nonzeroStartPeriod.Config.Healthcheck,
    StartPeriod: 1,
  };
  await expectDenied(
    { method: 'GET', url: `/v1.47/containers/${SANDBOX_ID}/json` },
    makeLookup({ sandbox: nonzeroStartPeriod }),
  );
});

test('create denial diagnostics expose shape only and never values or host sources', () => {
  const body = sandboxCreateBody();
  const summary = summarizeSandboxCreateDenial(body);
  const encoded = JSON.stringify(summary);
  assert.deepEqual(summary.environmentNames, body.Env.map((entry) => entry.split('=', 1)[0]).sort());
  assert.doesNotMatch(encoded, /eden3-egress-proxy|agent:agent-a:main|\/srv\/eden3\/openclaw-data/);
  assert.deepEqual(summary.bindShapes, [{ target: '/workspace', modes: ['z'] }]);

  assert.equal(summarizeSandboxCreateDenial(body, SANDBOX_NAME, policy).reason, null);
  assert.deepEqual(summarizeSandboxCreateDenial(body, SANDBOX_NAME, policy).bindShapes, [
    { target: '/workspace', modes: ['z'], sourceAuthority: 'workspace' },
  ]);
  assert.equal(summarizeSandboxCreateDenial({ ...body, Rootfs: '/host' }, SANDBOX_NAME, policy).reason, 'top_level_keys');
  assert.equal(summarizeSandboxCreateDenial({
    ...body,
    HostConfig: { ...body.HostConfig, Binds: ['/outside/workspace:/workspace:z'] },
  }, SANDBOX_NAME, policy).reason, 'binds');
});

test('rejects positive-schema extensions even when the ordinary sandbox shape remains present', async (t) => {
  const extensions = [
    ['unknown top-level field', { Rootfs: '/host' }],
    ['extra endpoint network', { NetworkingConfig: { EndpointsConfig: { channel_secret_db: {} } } }],
    ['secret-bearing environment', { Env: [...sandboxCreateBody().Env, 'CHANNEL_TOKEN_ENCRYPTION_KEY=stolen'] }],
    ['duplicate proxy environment', { Env: ['HTTP_PROXY=http://attacker.invalid', ...sandboxCreateBody().Env] }],
    ['executable tmpfs', { HostConfig: { ...sandboxCreateBody().HostConfig, Tmpfs: { '/tmp': 'exec', '/var/tmp': '', '/run': '' } } }],
    ['unknown host control', { HostConfig: { ...sandboxCreateBody().HostConfig, Runtime: 'evil-runtime' } }],
    ['extra caller label', { Labels: { ...sandboxCreateBody().Labels, 'attacker.claim': 'sandbox' } }],
    ['disabled seccomp', { HostConfig: { ...sandboxCreateBody().HostConfig, SecurityOpt: ['no-new-privileges', 'seccomp=unconfined'] } }],
  ];
  for (const [name, override] of extensions) {
    await t.test(name, async () => {
      await expectDenied({ method: 'POST', url: CREATE_URL, body: sandboxCreateBody(override) });
    });
  }
});

test('denies resolver impersonation and every direct key-recovery create primitive', async (t) => {
  const attacks = [
    ['resolver name', {}, '/v1.47/containers/create?name=eden3-channel-secret-resolver'],
    [
      'resolver image',
      { Image: 'eden3-channel-secret-resolver:latest' },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'missing sandbox label',
      { Labels: { 'openclaw.agentId': 'agent-a' } },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'host docker socket bind',
      {
        HostConfig: {
          ...sandboxCreateBody().HostConfig,
          Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
        },
      },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'secret resolver socket bind',
      {
        HostConfig: {
          ...sandboxCreateBody().HostConfig,
          Binds: ['/run/eden3:/run/eden3:ro'],
        },
      },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'host credential bind',
      {
        HostConfig: {
          ...sandboxCreateBody().HostConfig,
          Binds: ['/etc:/host-etc:ro'],
        },
      },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'workspace root rather than canonical child',
      {
        HostConfig: {
          ...sandboxCreateBody().HostConfig,
          Binds: [`${WORKSPACE_ROOT}:/workspace:rw`],
        },
      },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'workspace traversal',
      {
        HostConfig: {
          ...sandboxCreateBody().HostConfig,
          Binds: [`${WORKSPACE_ROOT}/agent-a/../../secrets:/workspace:rw`],
        },
      },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'privileged',
      { HostConfig: { ...sandboxCreateBody().HostConfig, Privileged: true } },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'host pid namespace',
      { HostConfig: { ...sandboxCreateBody().HostConfig, PidMode: 'host' } },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'host ipc namespace',
      { HostConfig: { ...sandboxCreateBody().HostConfig, IpcMode: 'host' } },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'host user namespace',
      { HostConfig: { ...sandboxCreateBody().HostConfig, UsernsMode: 'host' } },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'added capabilities',
      { HostConfig: { ...sandboxCreateBody().HostConfig, CapAdd: ['SYS_ADMIN'] } },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'host device',
      {
        HostConfig: {
          ...sandboxCreateBody().HostConfig,
          Devices: [{ PathOnHost: '/dev/mem', PathInContainer: '/dev/mem' }],
        },
      },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'published port',
      {
        HostConfig: {
          ...sandboxCreateBody().HostConfig,
          PortBindings: { '22/tcp': [{ HostPort: '2222' }] },
        },
      },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'wrong network',
      { HostConfig: { ...sandboxCreateBody().HostConfig, NetworkMode: 'host' } },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'unbounded memory',
      { HostConfig: { ...sandboxCreateBody().HostConfig, Memory: 0 } },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'excess memory',
      { HostConfig: { ...sandboxCreateBody().HostConfig, Memory: 769 * MIB } },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'unbounded pids',
      { HostConfig: { ...sandboxCreateBody().HostConfig, PidsLimit: 0 } },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'writable root',
      { HostConfig: { ...sandboxCreateBody().HostConfig, ReadonlyRootfs: false } },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
    [
      'missing no-new-privileges',
      { HostConfig: { ...sandboxCreateBody().HostConfig, SecurityOpt: [] } },
      '/v1.47/containers/create?name=openclaw-sbx-agent-a',
    ],
  ];

  for (const [name, overrides, url] of attacks) {
    await t.test(name, async () => {
      await expectDenied({
        method: 'POST',
        url: url === '/v1.47/containers/create?name=openclaw-sbx-agent-a' ? CREATE_URL : url,
        body: sandboxCreateBody(overrides),
      });
    });
  }
});

test('normalizes the Docker API boundary before routing and rejects ambiguity', async (t) => {
  const requests = [
    ['encoded traversal', '/v1.47/containers/%2e%2e/eden3-channel-secret-resolver/json'],
    ['encoded slash', `/v1.47/containers/${SANDBOX_ID}%2fexec`],
    ['double slash', `/v1.47//containers/${SANDBOX_ID}/json`],
    ['unsupported old API version', `/v0.0/containers/${SANDBOX_ID}/json`],
    ['version suffix smuggling', `/v1.47x/containers/${SANDBOX_ID}/json`],
  ];

  for (const [name, url] of requests) {
    await t.test(name, async () => {
      await expectDenied({ method: 'GET', url });
    });
  }

  await t.test('content-length plus transfer-encoding', async () => {
    await expectDenied({
      method: 'POST',
      url: CREATE_URL,
      headers: { 'content-length': '10', 'transfer-encoding': 'chunked' },
      body: sandboxCreateBody(),
    });
  });

  await t.test('oversized request body', async () => {
    await expectDenied({
      method: 'POST',
      url: CREATE_URL,
      headers: { 'content-length': String(policy.maxBodyBytes + 1) },
      body: sandboxCreateBody(),
    });
  });

  await t.test('upgrade on a non-streaming route', async () => {
    await expectDenied({
      method: 'GET',
      url: `/v1.47/containers/${SANDBOX_ID}/json`,
      headers: { connection: 'upgrade', upgrade: 'tcp' },
    });
  });
});

test('allows health/version and exact image inspection but denies daemon-wide discovery', async () => {
  await expectAllowed({ method: 'GET', url: '/_ping' });
  await expectAllowed({ method: 'HEAD', url: '/_ping' });
  await expectAllowed({ method: 'GET', url: '/v1.47/version' });
  await expectAllowed({ method: 'GET', url: `/v1.47/images/${IMAGE}/json` });

  const filters = encodeURIComponent(JSON.stringify({ label: ['openclaw.sandbox=1'] }));
  await expectDenied({
    method: 'GET',
    url: `/v1.47/containers/json?all=1&filters=${filters}`,
  });

  await expectDenied({ method: 'GET', url: '/v1.47/containers/json?all=1' });
  await expectDenied({ method: 'GET', url: '/v1.47/images/eden3-channel-secret-resolver:latest/json' });
  await expectDenied({ method: 'GET', url: '/v1.47/info' });
});

test('admits the captured Docker 27 image inspect and rejects the stale Docker 20 request shape', async () => {
  const current = await authorize({
    method: 'GET',
    url: `/v1.47/images/${IMAGE}/json`,
  });
  assert.deepEqual(current, { allowed: true, code: 'image_inspect' });

  const stale = await authorize({
    method: 'GET',
    url: `/v1.41/images/${IMAGE}/json`,
  });
  assert.deepEqual(stale, { allowed: false, code: 'path_invalid' });

  for (const url of [
    `/v1.47/images/${IMAGE}/json?all=1`,
    `/v1.47/images/${IMAGE}%2f..%2fjson`,
    `/v1.47/images/%252e%252e%252f${IMAGE}/json`,
    `/v1.47/images/../${IMAGE}/json`,
  ]) {
    await expectDenied({ method: 'GET', url });
  }
  await expectDenied({ method: 'GET', url: `/v1.47/images/${IMAGE}/json`, body: '{}' });
});

test('reattests full container configuration for lifecycle access and restart reconstruction', async () => {
  const lookup = makeLookup();

  await expectAllowed({ method: 'GET', url: `/v1.47/containers/${SANDBOX_ID}/json` }, lookup);
  await expectAllowed({ method: 'POST', url: `/v1.47/containers/${SANDBOX_ID}/start` }, lookup);
  await expectAllowed({ method: 'POST', url: `/v1.47/containers/${SANDBOX_ID}/stop?t=10` }, lookup);
  await expectAllowed({ method: 'GET', url: `/v1.47/containers/${SANDBOX_ID}/logs?stdout=1` }, lookup);
  await expectAllowed({ method: 'DELETE', url: `/v1.47/containers/${SANDBOX_ID}?force=1` }, lookup);

  const spoofedAfterRestart = sandboxInspect({
    HostConfig: { ...sandboxInspect().HostConfig, Privileged: true },
  });
  await expectDenied(
    { method: 'GET', url: `/v1.47/containers/${SANDBOX_ID}/json` },
    makeLookup({ sandbox: spoofedAfterRestart, issuedExecIds: new Map() }),
  );

  await expectDenied(
    { method: 'GET', url: `/v1.47/containers/${SANDBOX_ID}/json` },
    {
      ...makeLookup(),
      async inspectImage() { return { Id: 'sha256:replacement-image' }; },
    },
  );

  const spoofedImageProvenance = sandboxInspect();
  spoofedImageProvenance.Config.Labels['com.docker.compose.service'] = 'attacker-image';
  await expectDenied(
    { method: 'GET', url: `/v1.47/containers/${SANDBOX_ID}/json` },
    makeLookup({ sandbox: spoofedImageProvenance }),
  );

  const expanded = sandboxInspect({
    HostConfig: {
      ...sandboxInspect().HostConfig,
      CgroupnsMode: 'private',
      IpcMode: 'private',
      Runtime: 'runc',
      Init: null,
      LogConfig: { Type: 'json-file', Config: {} },
      ShmSize: 64 * MIB,
      MemorySwappiness: null,
      MaskedPaths: ['/proc/acpi'],
      ReadonlyPaths: ['/proc/asound'],
    },
  });
  await expectAllowed(
    { method: 'GET', url: `/v1.47/containers/${SANDBOX_ID}/json` },
    makeLookup({ sandbox: expanded }),
  );

  const hostIpc = sandboxInspect({
    HostConfig: { ...expanded.HostConfig, IpcMode: 'host' },
  });
  await expectDenied(
    { method: 'GET', url: `/v1.47/containers/${SANDBOX_ID}/json` },
    makeLookup({ sandbox: hostIpc }),
  );

  await expectDenied(
    { method: 'GET', url: `/v1.47/containers/${RESOLVER_ID}/json` },
    lookup,
  );
});

test('reattest uses the daemon-resolved mount source and rejects a bind symlink escape', async () => {
  const escaped = sandboxInspect({
    Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/workspace', RW: true }],
  });
  await expectDenied(
    { method: 'GET', url: `/v1.47/containers/${SANDBOX_ID}/json` },
    makeLookup({ sandbox: escaped }),
  );
});

test('server removes a newly created container when daemon-resolved mount postflight escapes', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'eden3-docker-guard-'));
  const socketPath = path.join(temporary, 'docker.sock');
  const workspaceRoot = path.join(temporary, 'workspaces');
  const workspace = path.join(workspaceRoot, 'agent-a');
  await mkdir(workspace, { recursive: true });
  const localPolicy = {
    ...policy,
    workspaceRoots: [workspaceRoot],
    resolveBindSource: (source) => source,
  };
  const createBody = sandboxCreateBody({
    HostConfig: {
      ...sandboxCreateBody().HostConfig,
      Binds: [`${workspace}:/workspace:z`],
      OomScoreAdj: 0,
    },
  });
  let cleanupCalls = 0;
  let forwardedCreate;
  const daemon = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url?.startsWith('/v1.47/containers/create?')) {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        forwardedCreate = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ Id: 'newcontainer' }));
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/containers/newcontainer/json') {
      const escapedInspect = sandboxInspect({
        Id: 'newcontainer',
        Config: {
          ...sandboxInspect().Config,
          Labels: forwardedCreate.Labels,
          Cmd: forwardedCreate.Cmd,
        },
        HostConfig: forwardedCreate.HostConfig,
        Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/workspace', RW: true }],
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(escapedInspect));
      return;
    }
    if (request.method === 'GET' && request.url === `/images/${encodeURIComponent(IMAGE)}/json`) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ Id: 'sha256:trusted-sandbox-image' }));
      return;
    }
    if (request.method === 'DELETE' && request.url === '/containers/newcontainer?force=1') {
      cleanupCalls += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    daemon.once('error', reject);
    daemon.listen(socketPath, resolve);
  });
  const guard = createGuardServer({ policy: localPolicy, socketPath });
  await new Promise((resolve, reject) => {
    guard.once('error', reject);
    guard.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => guard.close(resolve));
    await new Promise((resolve) => daemon.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });

  const body = Buffer.from(JSON.stringify(createBody));
  const response = await new Promise((resolve, reject) => {
    const address = guard.address();
    const request = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: CREATE_URL,
      headers: { 'content-type': 'application/json', 'content-length': body.length },
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => resolve({ statusCode: incoming.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
  assert.equal(response.statusCode, 502);
  assert.match(response.body, /create_postflight_failed/);
  assert.equal(forwardedCreate.HostConfig.OomScoreAdj, 1000);
  assert.equal(cleanupCalls, 1);
});

test('start gate removes a sandbox that cannot prove the mounted workspace sentinel', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'eden3-docker-guard-start-'));
  const socketPath = path.join(temporary, 'docker.sock');
  const workspaceRoot = path.join(temporary, 'workspaces');
  const workspace = path.join(workspaceRoot, 'agent-a');
  await mkdir(workspace, { recursive: true });
  const sentinelPath = path.join(workspace, SENTINEL);
  await writeFile(sentinelPath, '', { mode: 0o444, flag: 'wx' });
  const localPolicy = {
    ...policy,
    workspaceRoots: [workspaceRoot],
    resolveBindSource: (source) => source,
    inspectSentinel: undefined,
    startAttestationTimeoutMs: 100,
  };
  const create = sandboxCreateBody({
    HostConfig: {
      ...sandboxCreateBody().HostConfig,
      Binds: [`${workspace}:/workspace:z`],
    },
  });
  const inspected = sandboxInspect({
    Config: {
      ...sandboxInspect().Config,
      Labels: { ...sandboxInspect().Config.Labels, ...create.Labels, 'eden3.guard.mountSentinel': SENTINEL },
    },
    HostConfig: create.HostConfig,
    Mounts: [{ Type: 'bind', Source: workspace, Destination: '/workspace', RW: true }],
    State: { Running: false },
  });
  let cleanupCalls = 0;
  let startReceived = false;
  let postStartInspections = 0;
  const daemon = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === `/containers/${SANDBOX_ID}/json`) {
      let responseInspect = inspected;
      if (startReceived) {
        postStartInspections += 1;
        responseInspect = {
          ...inspected,
          State: postStartInspections === 1
            ? { Running: true, Health: { Status: 'starting' } }
            : { Running: false, Health: { Status: 'unhealthy' } },
        };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(responseInspect));
      return;
    }
    if (request.method === 'GET' && request.url === `/images/${encodeURIComponent(IMAGE)}/json`) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ Id: 'sha256:trusted-sandbox-image' }));
      return;
    }
    if (request.method === 'POST' && request.url === `/v1.47/containers/${SANDBOX_ID}/start`) {
      startReceived = true;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === 'DELETE' && request.url === `/containers/${SANDBOX_ID}?force=1`) {
      cleanupCalls += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    daemon.once('error', reject);
    daemon.listen(socketPath, resolve);
  });
  const guard = createGuardServer({ policy: localPolicy, socketPath });
  await new Promise((resolve, reject) => {
    guard.once('error', reject);
    guard.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => guard.close(resolve));
    await new Promise((resolve) => daemon.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });

  const response = await new Promise((resolve, reject) => {
    const address = guard.address();
    const request = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: `/v1.47/containers/${SANDBOX_ID}/start`,
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => resolve({ statusCode: incoming.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(response.statusCode, 502);
  assert.match(response.body, /start_postflight_failed/);
  assert.equal(cleanupCalls, 1);
  await assert.rejects(access(sentinelPath));
});

test('scopes exec creation to reattested sandboxes and exec use to this guard instance', async () => {
  const lookup = makeLookup();
  await expectAllowed(
    {
      method: 'POST',
      url: `/v1.47/containers/${SANDBOX_ID}/exec`,
      body: {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Cmd: ['sh', '-lc', 'echo bounded'],
        Detach: false,
        DetachKeys: '',
        Env: null,
        Privileged: false,
        Tty: false,
        User: '',
        WorkingDir: '',
      },
    },
    lookup,
  );
  await expectDenied(
    {
      method: 'POST',
      url: `/v1.47/containers/${RESOLVER_ID}/exec`,
      body: { Cmd: ['sh', '-lc', 'cat /proc/1/environ'] },
    },
    lookup,
  );

  await expectAllowed(
    {
      method: 'POST',
      url: '/v1.47/exec/exec-allowed/start',
      headers: { connection: 'upgrade', upgrade: 'tcp' },
      body: { Detach: false, Tty: false },
    },
    lookup,
  );
  await expectAllowed({ method: 'GET', url: '/v1.47/exec/exec-allowed/json' }, lookup);
  await expectAllowed({ method: 'POST', url: '/v1.47/exec/exec-allowed/resize?h=40&w=120' }, lookup);

  await expectDenied(
    { method: 'POST', url: '/v1.47/exec/exec-resolver/start', body: {} },
    lookup,
  );
  await expectDenied(
    { method: 'POST', url: '/v1.47/exec/exec-foreign/start', body: {} },
    makeLookup({
      issuedExecIds: new Map(),
      execs: new Map([['exec-foreign', { ID: 'exec-foreign', ContainerID: SANDBOX_ID }]]),
    }),
  );
  await expectDenied(
    { method: 'POST', url: '/v1.47/exec/exec-allowed/start', body: {} },
    makeLookup({ issuedExecIds: new Map() }),
  );
});

test('denies archive/cp and all daemon mutation outside the sandbox contract', async (t) => {
  const denied = [
    ['GET', `/v1.47/containers/${SANDBOX_ID}/archive?path=/workspace`],
    ['PUT', `/v1.47/containers/${SANDBOX_ID}/archive?path=/workspace`],
    ['POST', '/v1.47/images/create?fromImage=alpine'],
    ['DELETE', `/v1.47/images/${IMAGE}`],
    ['POST', '/v1.47/build'],
    ['POST', '/v1.47/volumes/create'],
    ['POST', '/v1.47/networks/create'],
    ['POST', '/v1.47/containers/prune'],
    ['POST', '/v1.47/auth'],
    ['GET', '/v1.47/secrets'],
    ['GET', '/v1.47/swarm'],
    ['POST', '/v1.47/plugins/pull'],
  ];

  for (const [method, url] of denied) {
    await t.test(`${method} ${url}`, async () => {
      await expectDenied({ method, url });
    });
  }
});
