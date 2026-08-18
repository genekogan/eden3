import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { closeSync, lstatSync, openSync, realpathSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_MEMORY_BYTES = 768 * 1024 * 1024;
const DEFAULT_MAX_PIDS = 128;
const REQUEST_TIMEOUT_MS = 30_000;
const EXEC_STREAM_TIMEOUT_MS = 31 * 60 * 1000;
const EXEC_CAPABILITY_TTL_MS = 60 * 60 * 1000;
const MAX_EXEC_CAPABILITIES = 4096;
const SAFE_SEGMENT = /^[A-Za-z0-9_.:-]{1,255}$/u;
const SANDBOX_NAME = /^\/?openclaw-sbx-[a-z0-9][a-z0-9_.-]{0,31}-[a-f0-9]{8}$/u;
const SENSITIVE_ENV = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|DATABASE_URL|DOCKER_HOST|ENCRYPTION_KEY)(?:_|$)/iu;
const MOUNT_SENTINEL = /^\.eden3-mount-attestation-[a-f0-9]{32}$/u;
const MOUNT_READY_PATH = '/tmp/eden3-mount-ready';
const MOUNT_CHECK_SCRIPT = `test -f "$1" && : > ${MOUNT_READY_PATH} && exec sleep infinity`;
const START_ATTESTATION_TIMEOUT_MS = 8000;
const START_ATTESTATION_POLL_MS = 100;
const CREATE_KEYS = new Set([
  'Hostname', 'Domainname', 'User', 'AttachStdin', 'AttachStdout', 'AttachStderr',
  'Tty', 'OpenStdin', 'StdinOnce', 'Env', 'Cmd', 'Image', 'Volumes', 'WorkingDir',
  'Entrypoint', 'OnBuild', 'Labels', 'HostConfig', 'NetworkingConfig',
]);
const HOST_CONFIG_KEYS = new Set([
  'Binds', 'ContainerIDFile', 'LogConfig', 'NetworkMode', 'PortBindings',
  'RestartPolicy', 'AutoRemove', 'VolumeDriver', 'VolumesFrom', 'ConsoleSize',
  'CapAdd', 'CapDrop', 'CgroupnsMode', 'Dns', 'DnsOptions', 'DnsSearch',
  'ExtraHosts', 'GroupAdd', 'IpcMode', 'Cgroup', 'Links', 'OomScoreAdj', 'PidMode',
  'Privileged', 'PublishAllPorts', 'ReadonlyRootfs', 'SecurityOpt', 'Tmpfs',
  'UTSMode', 'UsernsMode', 'ShmSize', 'Isolation', 'CpuShares', 'Memory',
  'NanoCpus', 'CgroupParent', 'BlkioWeight', 'BlkioWeightDevice',
  'BlkioDeviceReadBps', 'BlkioDeviceWriteBps', 'BlkioDeviceReadIOps',
  'BlkioDeviceWriteIOps', 'CpuPeriod', 'CpuQuota', 'CpuRealtimePeriod',
  'CpuRealtimeRuntime', 'CpusetCpus', 'CpusetMems', 'Devices', 'DeviceCgroupRules',
  'DeviceRequests', 'MemoryReservation', 'MemorySwap', 'MemorySwappiness',
  'OomKillDisable', 'PidsLimit', 'Ulimits', 'CpuCount', 'CpuPercent',
  'IOMaximumIOps', 'IOMaximumBandwidth', 'MaskedPaths', 'ReadonlyPaths',
  'Init', 'Runtime',
]);

export function policyFromEnv(env = process.env) {
  const split = (value) => (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const required = (name) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  return {
    allowedImages: split(required('EDEN3_SANDBOX_ALLOWED_IMAGES')),
    allowedNetworks: split(required('EDEN3_SANDBOX_ALLOWED_NETWORKS')),
    workspaceRoots: split(required('EDEN3_SANDBOX_WORKSPACE_ROOTS')).map((value) => realpathSync(canonicalRoot(value))),
    assetRoots: split(required('EDEN3_SANDBOX_ASSET_ROOTS')).map((value) => realpathSync(canonicalRoot(value))),
    resolveBindSource: (value) => realpathSync(value),
    maxBodyBytes: boundedInteger(env.EDEN3_DOCKER_GUARD_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES),
    maxMemoryBytes: boundedInteger(env.EDEN3_SANDBOX_MAX_MEMORY_BYTES, DEFAULT_MAX_MEMORY_BYTES),
    maxPids: boundedInteger(env.EDEN3_SANDBOX_MAX_PIDS, DEFAULT_MAX_PIDS),
  };
}

function boundedInteger(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('guard bounds must be positive integers');
  return value;
}

function canonicalRoot(value) {
  if (!path.isAbsolute(value)) throw new Error('guard roots must be absolute');
  const normalized = path.posix.normalize(value);
  if (normalized === '/' || normalized !== value.replace(/\/$/u, '')) {
    throw new Error('guard roots must be canonical and may not be host root');
  }
  return normalized;
}

function decision(allowed, code, extra = {}) {
  return { allowed, code, ...extra };
}

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()] ?? headers?.[name.toUpperCase()];
  if (Array.isArray(value)) return value.join(',');
  return value === undefined ? '' : String(value);
}

function parseRoute(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 4096) return null;
  const question = rawUrl.indexOf('?');
  const rawPath = question === -1 ? rawUrl : rawUrl.slice(0, question);
  if (!rawPath.startsWith('/') || rawPath.includes('%') || rawPath.includes('\\') || rawPath.includes('//')) return null;
  let normalizedPath = rawPath;
  const version = normalizedPath.match(/^\/v(\d+(?:\.\d+)?)(?=\/)/u);
  if (version) {
    if (!['1.44', '1.45', '1.46', '1.47'].includes(version[1])) return null;
    normalizedPath = normalizedPath.slice(version[0].length);
  }
  if (!normalizedPath.startsWith('/') || normalizedPath.includes('/./') || normalizedPath.includes('/../')) return null;
  let url;
  try {
    url = new URL(rawUrl, 'http://guard.invalid');
  } catch {
    return null;
  }
  return { normalizedPath, searchParams: url.searchParams };
}

function parseBody(input) {
  if (input === undefined || input === null || input.length === 0) return null;
  if (Buffer.isBuffer(input) || typeof input === 'string') {
    try {
      return JSON.parse(String(input));
    } catch {
      return Symbol.for('invalid-json');
    }
  }
  return input;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasAmbiguousBody(input, maxBodyBytes) {
  const headers = input.headers ?? {};
  const transferEncoding = headerValue(headers, 'transfer-encoding');
  const contentLengthRaw = headerValue(headers, 'content-length');
  if (transferEncoding) return true;
  if (input.body === undefined || input.body === null) return false;
  if ((Buffer.isBuffer(input.body) || typeof input.body === 'string') && Buffer.byteLength(input.body) === 0) {
    return contentLengthRaw !== '' && contentLengthRaw !== '0';
  }
  // Pure policy callers use already-parsed objects. The HTTP boundary always
  // supplies bytes and is therefore subject to exact framing checks.
  if (!Buffer.isBuffer(input.body) && typeof input.body !== 'string') {
    return contentLengthRaw !== '' && (!/^\d+$/u.test(contentLengthRaw) || Number(contentLengthRaw) > maxBodyBytes);
  }
  if (!/^\d+$/u.test(contentLengthRaw)) return true;
  const declared = Number(contentLengthRaw);
  const actual = Buffer.byteLength(Buffer.isBuffer(input.body) ? input.body : typeof input.body === 'string' ? input.body : JSON.stringify(input.body));
  return declared !== actual || declared > maxBodyBytes;
}

function singleQuery(params, name) {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function exactQuery(params, allowed) {
  return [...params.keys()].every((key) => allowed.has(key))
    && [...new Set(params.keys())].every((key) => params.getAll(key).length === 1);
}

function boundedQueryInteger(params, name, minimum, maximum, required = false) {
  const values = params.getAll(name);
  if (values.length === 0) return !required;
  if (values.length !== 1 || !/^\d+$/u.test(values[0])) return false;
  const value = Number(values[0]);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function resolvedSource(candidate, policy) {
  try {
    return policy.resolveBindSource ? policy.resolveBindSource(candidate) : candidate;
  } catch {
    return null;
  }
}

function withinRoot(candidate, roots, policy) {
  if (typeof candidate !== 'string' || !path.posix.isAbsolute(candidate)) return false;
  const normalized = path.posix.normalize(candidate);
  if (normalized !== candidate.replace(/\/$/u, '')) return false;
  const resolved = resolvedSource(normalized, policy);
  return resolved !== null && roots.some((root) => resolved !== root && resolved.startsWith(`${root}/`));
}

function parseBind(bind) {
  if (typeof bind !== 'string' || bind.includes('\0')) return null;
  const parts = bind.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const [source, target, mode = 'rw'] = parts;
  if (!source || !target || !path.posix.isAbsolute(source) || !path.posix.isAbsolute(target)) return null;
  const modes = new Set(mode.split(','));
  if ([...modes].some((entry) => !['ro', 'rw', 'rprivate', 'rslave', 'z', 'Z'].includes(entry))) return null;
  return { source, target, readOnly: modes.has('ro'), modes };
}

function verifiedBinds(binds, policy) {
  if (!Array.isArray(binds) || binds.length < 1 || binds.length > 32) return false;
  let workspace = 0;
  let sharedAssets = 0;
  for (const raw of binds) {
    const bind = parseBind(raw);
    if (!bind) return false;
    if (bind.target === '/workspace') {
      if (bind.readOnly || bind.modes.size !== 1 || !bind.modes.has('z') || !withinRoot(bind.source, policy.workspaceRoots, policy)) return false;
      workspace += 1;
      continue;
    }
    if (bind.target.startsWith('/workspace/') && bind.readOnly && bind.modes.size === 2 && bind.modes.has('z') && withinRoot(bind.source, policy.workspaceRoots, policy)) continue;
    if (bind.target === '/shared-assets' && bind.readOnly && bind.modes.size === 1 && policy.assetRoots.includes(resolvedSource(path.posix.normalize(bind.source), policy))) {
      sharedAssets += 1;
      continue;
    }
    return false;
  }
  return workspace === 1 && sharedAssets <= 1;
}

function safeEnv(entries) {
  if (entries === undefined || entries === null) return true;
  if (!Array.isArray(entries) || entries.length > 128) return false;
  return entries.every((entry) => {
    if (typeof entry !== 'string' || Buffer.byteLength(entry) > 4096) return false;
    const equals = entry.indexOf('=');
    const name = equals === -1 ? entry : entry.slice(0, equals);
    return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && !SENSITIVE_ENV.test(name);
  });
}

function uniqueEnvMap(entries) {
  if (!safeEnv(entries) || !Array.isArray(entries)) return null;
  const actual = new Map();
  for (const entry of entries) {
    const index = entry.indexOf('=');
    if (index <= 0) return null;
    const name = entry.slice(0, index);
    if (actual.has(name)) return null;
    actual.set(name, entry.slice(index + 1));
  }
  return actual;
}

function exactSandboxEnv(entries) {
  const actual = uniqueEnvMap(entries);
  if (!actual) return false;
  const expected = new Map([
    ['HTTP_PROXY', 'http://eden3-egress-proxy:8080'],
    ['HTTPS_PROXY', 'http://eden3-egress-proxy:8080'],
    ['http_proxy', 'http://eden3-egress-proxy:8080'],
    ['https_proxy', 'http://eden3-egress-proxy:8080'],
    ['NO_PROXY', 'localhost,127.0.0.1,::1'],
    ['no_proxy', 'localhost,127.0.0.1,::1'],
    ['OPENCLAW_CLI', '1'],
  ]);
  return actual.size === expected.size && [...expected].every(([key, value]) => actual.get(key) === value);
}

function containsSandboxEnv(entries) {
  const actual = uniqueEnvMap(entries);
  if (!actual) return false;
  const required = [
    ['HTTP_PROXY', 'http://eden3-egress-proxy:8080'],
    ['HTTPS_PROXY', 'http://eden3-egress-proxy:8080'],
    ['http_proxy', 'http://eden3-egress-proxy:8080'],
    ['https_proxy', 'http://eden3-egress-proxy:8080'],
    ['NO_PROXY', 'localhost,127.0.0.1,::1'],
    ['no_proxy', 'localhost,127.0.0.1,::1'],
    ['OPENCLAW_CLI', '1'],
  ];
  return required.every(([key, value]) => actual.get(key) === value);
}

function nullOrEmpty(value) {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function emptyObject(value) {
  return value === undefined || (isPlainObject(value) && Object.keys(value).length === 0);
}

function inert(value) {
  if (value === undefined || value === null || value === false || value === 0 || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return isPlainObject(value) && Object.keys(value).length === 0;
}

function safeDefaults(host, strictKeys) {
  for (const [key, value] of Object.entries(host)) {
    if (!HOST_CONFIG_KEYS.has(key) && (strictKeys || !inert(value))) return false;
  }
  for (const key of ['CapAdd', 'Devices', 'DeviceCgroupRules', 'DeviceRequests', 'ExtraHosts', 'GroupAdd', 'Links', 'Ulimits', 'VolumesFrom']) {
    if (!nullOrEmpty(host[key])) return false;
  }
  for (const key of ['MaskedPaths', 'ReadonlyPaths']) {
    if (strictKeys) {
      if (!nullOrEmpty(host[key])) return false;
    } else if (host[key] !== undefined && (!Array.isArray(host[key]) || host[key].length > 64 || host[key].some((entry) => typeof entry !== 'string' || !entry.startsWith('/')))) {
      return false;
    }
  }
  for (const key of ['PortBindings']) if (!emptyObject(host[key])) return false;
  for (const key of ['PidMode', 'UTSMode', 'UsernsMode', 'Cgroup', 'CgroupParent', 'Isolation', 'VolumeDriver', 'ContainerIDFile', 'CpusetCpus', 'CpusetMems']) {
    if (host[key] !== undefined && host[key] !== '') return false;
  }
  if (strictKeys
    ? host.IpcMode !== undefined && host.IpcMode !== ''
    : ![undefined, '', 'private'].includes(host.IpcMode)) return false;
  if (strictKeys ? (host.CgroupnsMode !== undefined && host.CgroupnsMode !== '') : !['', 'private', undefined].includes(host.CgroupnsMode)) return false;
  if (strictKeys ? (host.Runtime !== undefined && host.Runtime !== '') : !['', 'runc', undefined].includes(host.Runtime)) return false;
  if (host.Init !== undefined && host.Init !== null && host.Init !== false) return false;
  if (host.AutoRemove === true || host.OomKillDisable === true) return false;
  if (host.RestartPolicy !== undefined && (host.RestartPolicy?.Name !== 'no' || Number(host.RestartPolicy?.MaximumRetryCount ?? 0) !== 0)) return false;
  if (host.LogConfig !== undefined
    && (strictKeys ? host.LogConfig?.Type !== '' : !['', 'json-file', 'local'].includes(host.LogConfig?.Type))
    || host.LogConfig !== undefined && !isPlainObject(host.LogConfig?.Config)) return false;
  const zeroKeys = [
    'ShmSize', 'CpuShares', 'NanoCpus', 'BlkioWeight', 'CpuPeriod', 'CpuQuota',
    'CpuRealtimePeriod', 'CpuRealtimeRuntime', 'MemoryReservation', 'CpuCount',
    'CpuPercent', 'IOMaximumIOps', 'IOMaximumBandwidth',
  ];
  if (zeroKeys.some((key) => host[key] !== undefined && host[key] !== 0 && !(key === 'ShmSize' && !strictKeys && host[key] === 64 * 1024 * 1024))) return false;
  for (const key of ['BlkioWeightDevice', 'BlkioDeviceReadBps', 'BlkioDeviceWriteBps', 'BlkioDeviceReadIOps', 'BlkioDeviceWriteIOps', 'Dns', 'DnsOptions', 'DnsSearch']) {
    if (host[key] !== undefined && (!Array.isArray(host[key]) || host[key].length !== 0)) return false;
  }
  if (strictKeys
    ? host.MemorySwappiness !== undefined && host.MemorySwappiness !== -1
    : host.MemorySwappiness !== undefined && host.MemorySwappiness !== null && host.MemorySwappiness !== -1) return false;
  if (host.ConsoleSize !== undefined && (!Array.isArray(host.ConsoleSize) || host.ConsoleSize.length !== 2 || host.ConsoleSize.some((value) => value !== 0))) return false;
  return true;
}

function exactNetwork(inspect, allowedNetworks) {
  const mode = inspect?.HostConfig?.NetworkMode;
  if (!allowedNetworks.includes(mode)) return false;
  const attached = Object.keys(inspect?.NetworkSettings?.Networks ?? {});
  return attached.length === 0 || (attached.length === 1 && attached[0] === mode);
}

function safeHostConfig(host, policy, strictKeys = false, guardWillSetOomScore = false) {
  if (!isPlainObject(host)) return false;
  if (!safeDefaults(host, strictKeys)) return false;
  const forbiddenTruthy = [
    'Privileged', 'PublishAllPorts', 'AutoRemove', 'Init',
  ];
  if (forbiddenTruthy.some((key) => host[key] === true)) return false;
  const forbiddenPresent = [
    'Devices', 'DeviceRequests', 'CapAdd', 'PortBindings', 'Links', 'Dns', 'DnsOptions',
    'ExtraHosts', 'GroupAdd', 'VolumesFrom', 'Mounts',
  ];
  if (forbiddenPresent.some((key) => Array.isArray(host[key]) ? host[key].length > 0 : isPlainObject(host[key]) ? Object.keys(host[key]).length > 0 : Boolean(host[key]))) return false;
  for (const key of ['PidMode', 'UTSMode', 'UsernsMode']) {
    if (host[key] !== undefined && host[key] !== '') return false;
  }
  if (strictKeys
    ? host.IpcMode !== undefined && host.IpcMode !== ''
    : ![undefined, '', 'private'].includes(host.IpcMode)) return false;
  if (host.NetworkMode?.startsWith('container:') || host.NetworkMode === 'host' || !policy.allowedNetworks.includes(host.NetworkMode)) return false;
  if (host.ReadonlyRootfs !== true) return false;
  if (!Array.isArray(host.CapDrop) || host.CapDrop.length !== 1 || String(host.CapDrop[0]).toUpperCase() !== 'ALL') return false;
  if (!Array.isArray(host.SecurityOpt) || host.SecurityOpt.length !== 1 || host.SecurityOpt[0] !== 'no-new-privileges') return false;
  const tmpfs = host.Tmpfs;
  if (!isPlainObject(tmpfs) || Object.keys(tmpfs).length !== 3 || !['/tmp', '/var/tmp', '/run'].every((target) => Object.hasOwn(tmpfs, target))) return false;
  if (Object.values(tmpfs).some((options) => options !== '')) return false;
  if (!Number.isSafeInteger(host.Memory) || host.Memory <= 0 || host.Memory > policy.maxMemoryBytes) return false;
  if (host.MemorySwap !== host.Memory) return false;
  if (!Number.isSafeInteger(host.PidsLimit) || host.PidsLimit <= 0 || host.PidsLimit > policy.maxPids) return false;
  if (guardWillSetOomScore ? ![0, 1000].includes(host.OomScoreAdj) : host.OomScoreAdj !== 1000) return false;
  return verifiedBinds(host.Binds, policy);
}

function verifiedActualMounts(mounts, policy, expectedCount) {
  if (!Array.isArray(mounts) || mounts.length !== expectedCount) return false;
  let workspace = 0;
  let sharedAssets = 0;
  for (const mount of mounts) {
    if (mount?.Type !== 'bind' || typeof mount.Source !== 'string' || typeof mount.Destination !== 'string') return false;
    const source = resolvedSource(path.posix.normalize(mount.Source), policy);
    if (!source) return false;
    if (mount.Destination === '/workspace') {
      if (mount.RW !== true || !withinRoot(source, policy.workspaceRoots, policy)) return false;
      workspace += 1;
      continue;
    }
    if ((mount.Destination === '/agent' || mount.Destination.startsWith('/workspace/')) && mount.RW === false && withinRoot(source, policy.workspaceRoots, policy)) continue;
    if (mount.Destination === '/shared-assets' && mount.RW === false && policy.assetRoots.includes(source)) {
      sharedAssets += 1;
      continue;
    }
    return false;
  }
  return workspace === 1 && sharedAssets <= 1;
}

function workspaceMount(inspect) {
  return inspect?.Mounts?.find((mount) => mount?.Type === 'bind' && mount.Destination === '/workspace') ?? null;
}

function sentinelHostPath(inspect, policy) {
  const name = inspect?.Config?.Labels?.['eden3.guard.mountSentinel'];
  const mount = workspaceMount(inspect);
  if (!MOUNT_SENTINEL.test(name ?? '') || !mount || !withinRoot(mount.Source, policy.workspaceRoots, policy)) return null;
  const candidate = path.posix.join(resolvedSource(mount.Source, policy), name);
  if (typeof policy.inspectSentinel === 'function') return policy.inspectSentinel(candidate) ? candidate : null;
  try {
    const stat = lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === 0 && stat.nlink === 1 ? candidate : null;
  } catch {
    return null;
  }
}

function createBodyDenialReason(body, name, policy) {
  if (!isPlainObject(body)) return 'body_shape';
  if (!SANDBOX_NAME.test(name)) return 'container_name';
  if (Object.keys(body).some((key) => !CREATE_KEYS.has(key))) return 'top_level_keys';
  if (!policy.allowedImages.includes(body.Image)) return 'image';
  const labelKeys = Object.keys(body.Labels ?? {}).toSorted();
  const expectedLabels = ['openclaw.configHash', 'openclaw.createdAtMs', 'openclaw.mountFormatVersion', 'openclaw.sandbox', 'openclaw.sessionKey'];
  if (JSON.stringify(labelKeys) !== JSON.stringify(expectedLabels)) return 'label_keys';
  if (body.Labels['openclaw.sandbox'] !== '1'
    || body.Labels['openclaw.mountFormatVersion'] !== '3'
    || !/^[a-f0-9]{64}$/u.test(body.Labels['openclaw.configHash'])
    || !/^\d{13}$/u.test(body.Labels['openclaw.createdAtMs'])
    || typeof body.Labels['openclaw.sessionKey'] !== 'string'
    || body.Labels['openclaw.sessionKey'].length > 512) return 'labels';
  if (body.Cmd !== undefined && (!Array.isArray(body.Cmd) || body.Cmd.length !== 2 || body.Cmd[0] !== 'sleep' || body.Cmd[1] !== 'infinity')) return 'command';
  if (body.WorkingDir !== undefined && body.WorkingDir !== '/workspace') return 'working_directory';
  if (!exactSandboxEnv(body.Env)) return 'environment';
  if (body.User && !['sandbox', '1000:1000'].includes(body.User)) return 'user';
  if (!emptyObject(body.Volumes) || !nullOrEmpty(body.Entrypoint) || !nullOrEmpty(body.OnBuild)) return 'volumes_or_entrypoint';
  if (body.NetworkingConfig !== undefined
    && (!isPlainObject(body.NetworkingConfig)
      || !emptyObject(body.NetworkingConfig.EndpointsConfig)
      || Object.keys(body.NetworkingConfig).some((key) => key !== 'EndpointsConfig'))) return 'networking_config';
  if (!isPlainObject(body.HostConfig)) return 'host_config_shape';
  if (!safeDefaults(body.HostConfig, true)) return 'host_config_defaults';
  if (!verifiedBinds(body.HostConfig.Binds, policy)) return 'binds';
  if (!safeHostConfig(body.HostConfig, policy, true, true)) return 'host_config_policy';
  return null;
}

function verifyCreateBody(body, name, policy) {
  return createBodyDenialReason(body, name, policy) === null;
}

export function summarizeSandboxCreateDenial(body, name, policy) {
  if (!isPlainObject(body)) return { bodyType: Array.isArray(body) ? 'array' : typeof body };
  const host = isPlainObject(body.HostConfig) ? body.HostConfig : {};
  const environmentNames = Array.isArray(body.Env)
    ? body.Env.map((entry) => typeof entry === 'string' ? entry.split('=', 1)[0] : typeof entry).sort()
    : [];
  const bindShapes = Array.isArray(host.Binds)
    ? host.Binds.map((entry) => {
      const parsed = parseBind(entry);
      if (!parsed) return { invalid: true };
      const resolved = policy ? resolvedSource(path.posix.normalize(parsed.source), policy) : null;
      const sourceAuthority = !policy ? undefined
        : resolved === null ? 'unresolved'
          : policy.assetRoots.includes(resolved) ? 'assets'
            : withinRoot(parsed.source, policy.workspaceRoots, policy) ? 'workspace'
              : 'outside';
      return {
        target: parsed.target,
        modes: [...parsed.modes].sort(),
        ...(sourceAuthority === undefined ? {} : { sourceAuthority }),
      };
    })
    : [];
  return {
    reason: name && policy ? createBodyDenialReason(body, name, policy) : undefined,
    topLevelKeys: Object.keys(body).sort(),
    labelKeys: isPlainObject(body.Labels) ? Object.keys(body.Labels).sort() : [],
    environmentNames,
    image: typeof body.Image === 'string' ? body.Image : typeof body.Image,
    user: typeof body.User === 'string' ? body.User : typeof body.User,
    command: Array.isArray(body.Cmd) ? body.Cmd : typeof body.Cmd,
    workingDirectory: typeof body.WorkingDir === 'string' ? body.WorkingDir : typeof body.WorkingDir,
    hostConfigKeys: Object.keys(host).sort(),
    networkMode: host.NetworkMode,
    memory: host.Memory,
    memorySwap: host.MemorySwap,
    pidsLimit: host.PidsLimit,
    oomScoreAdj: host.OomScoreAdj,
    readonlyRootfs: host.ReadonlyRootfs,
    capDrop: host.CapDrop,
    securityOpt: host.SecurityOpt,
    tmpfs: isPlainObject(host.Tmpfs) ? Object.fromEntries(Object.entries(host.Tmpfs).sort()) : host.Tmpfs,
    bindShapes,
  };
}

function containerInspectionDenialReason(inspect, policy) {
  if (!isPlainObject(inspect)) return 'inspect_shape';
  if (!SANDBOX_NAME.test(inspect.Name ?? '')) return 'container_name';
  if (!policy.allowedImages.includes(inspect.Config?.Image)) return 'image';
  const labelKeys = Object.keys(inspect.Config?.Labels ?? {}).toSorted();
  const expectedLabels = [
    'com.docker.compose.project', 'com.docker.compose.service', 'com.docker.compose.version',
    'eden3.guard.mountSentinel', 'openclaw.configHash', 'openclaw.createdAtMs',
    'openclaw.mountFormatVersion', 'openclaw.sandbox', 'openclaw.sessionKey',
  ];
  if (JSON.stringify(labelKeys) !== JSON.stringify(expectedLabels)
    || inspect.Config.Labels['com.docker.compose.project'] !== 'eden3'
    || inspect.Config.Labels['com.docker.compose.service'] !== 'openclaw-sandbox-media'
    || inspect.Config.Labels['com.docker.compose.version'] !== '2.34.0'
    || inspect.Config.Labels['openclaw.sandbox'] !== '1'
    || inspect.Config.Labels['openclaw.mountFormatVersion'] !== '3'
    || !MOUNT_SENTINEL.test(inspect.Config.Labels['eden3.guard.mountSentinel'])
    || !/^[a-f0-9]{64}$/u.test(inspect.Config.Labels['openclaw.configHash'])
    || !/^\d{13}$/u.test(inspect.Config.Labels['openclaw.createdAtMs'])) return 'labels';
  const sentinelPath = `/workspace/${inspect.Config.Labels['eden3.guard.mountSentinel']}`;
  if (!Array.isArray(inspect.Config?.Cmd)
    || inspect.Config.Cmd.length !== 5
    || inspect.Config.Cmd[0] !== '/bin/sh'
    || inspect.Config.Cmd[1] !== '-c'
    || inspect.Config.Cmd[2] !== MOUNT_CHECK_SCRIPT
    || inspect.Config.Cmd[3] !== 'eden3-mount-check'
    || inspect.Config.Cmd[4] !== sentinelPath) return 'command';
  if (inspect.Config?.Entrypoint !== undefined && inspect.Config.Entrypoint !== null) return 'entrypoint';
  const healthcheck = inspect.Config?.Healthcheck;
  if (!isPlainObject(healthcheck)
    || JSON.stringify(healthcheck.Test) !== JSON.stringify(['CMD-SHELL', `test -f ${MOUNT_READY_PATH}`])
    || healthcheck.Interval !== 1_000_000_000
    || healthcheck.Timeout !== 2_000_000_000
    || healthcheck.Retries !== 1
    // Docker omits a zero StartPeriod from the daemon-resolved inspect
    // response. Treat only that omission as the exact zero default.
    || (healthcheck.StartPeriod ?? 0) !== 0) return 'healthcheck';
  if (inspect.Config?.WorkingDir !== undefined && inspect.Config.WorkingDir !== '/workspace') return 'working_directory';
  if (!containsSandboxEnv(inspect.Config?.Env)) return 'environment';
  if (inspect.Config?.User && !['sandbox', '1000:1000'].includes(inspect.Config.User)) return 'user';
  if (!safeHostConfig(inspect.HostConfig, policy)) return 'host_config';
  if (!exactNetwork(inspect, policy.allowedNetworks)) return 'network';
  if (!verifiedActualMounts(inspect.Mounts, policy, inspect.HostConfig.Binds.length)) return 'mounts';
  return null;
}

export function verifyContainerInspection(inspect, policy) {
  return containerInspectionDenialReason(inspect, policy) === null;
}

async function getAttestedContainer(id, policy, lookup) {
  if (!SAFE_SEGMENT.test(id) || typeof lookup?.inspectContainer !== 'function') return null;
  try {
    const inspect = await lookup.inspectContainer(id);
    if (!verifyContainerInspection(inspect, policy) || !SAFE_SEGMENT.test(inspect.Id ?? '') || !sentinelHostPath(inspect, policy)) return null;
    const image = await lookup.inspectImage?.(inspect.Config.Image);
    return image?.Id === inspect.Image ? inspect : null;
  } catch {
    return null;
  }
}

async function containerPostflightDenialReason(id, policy, lookup) {
  if (!SAFE_SEGMENT.test(id) || typeof lookup?.inspectContainer !== 'function') return 'container_identity';
  try {
    const inspect = await lookup.inspectContainer(id);
    const inspectionReason = containerInspectionDenialReason(inspect, policy);
    if (inspectionReason) return inspectionReason;
    if (!SAFE_SEGMENT.test(inspect.Id ?? '')) return 'resolved_container_identity';
    if (!sentinelHostPath(inspect, policy)) return 'mount_sentinel';
    const image = await lookup.inspectImage?.(inspect.Config.Image);
    if (image?.Id !== inspect.Image) return 'image_identity';
    return 'unknown';
  } catch {
    return 'inspection_unavailable';
  }
}

async function containerPostflightDenialReport(id, policy, lookup) {
  const reason = await containerPostflightDenialReason(id, policy, lookup);
  if (reason !== 'host_config') return { reason };
  try {
    const inspect = await lookup.inspectContainer(id);
    const shape = summarizeSandboxCreateDenial({
      HostConfig: inspect?.HostConfig,
    }, undefined, policy);
    return {
      reason,
      hostConfigKeys: shape.hostConfigKeys,
      networkMode: shape.networkMode,
      memory: shape.memory,
      memorySwap: shape.memorySwap,
      pidsLimit: shape.pidsLimit,
      oomScoreAdj: shape.oomScoreAdj,
      readonlyRootfs: shape.readonlyRootfs,
      capDrop: shape.capDrop,
      securityOpt: shape.securityOpt,
      tmpfs: shape.tmpfs,
      bindShapes: shape.bindShapes,
    };
  } catch {
    return { reason };
  }
}

async function attestContainer(id, policy, lookup) {
  return Boolean(await getAttestedContainer(id, policy, lookup));
}

function verifyExecBody(body) {
  if (!isPlainObject(body) || !Array.isArray(body.Cmd) || body.Cmd.length === 0 || body.Cmd.length > 256) return false;
  if (body.Cmd.some((part) => typeof part !== 'string' || Buffer.byteLength(part) > 65_536)) return false;
  if (body.Privileged !== false || body.Detach !== false || (body.User !== undefined && body.User !== '' && body.User !== 'sandbox')) return false;
  if (!safeEnv(body.Env)) return false;
  const allowed = new Set(['AttachStdin', 'AttachStdout', 'AttachStderr', 'Cmd', 'Detach', 'DetachKeys', 'Env', 'Privileged', 'Tty', 'User', 'WorkingDir']);
  return Object.keys(body).every((key) => allowed.has(key));
}

function verifyExecStartBody(body) {
  if (!isPlainObject(body)) return false;
  return Object.keys(body).every((key) => key === 'Detach' || key === 'Tty') && typeof body.Detach === 'boolean' && typeof body.Tty === 'boolean';
}

async function getAttestedIssuedExec(id, policy, lookup) {
  const issued = lookup?.issuedExecIds?.get?.(id);
  if (!issued) return null;
  const issuedContainerId = typeof issued === 'string' ? issued : issued.containerId;
  if (typeof issued !== 'string' && issued.expiresAt <= Date.now()) return null;
  let inspected;
  try {
    inspected = await lookup.inspectExec(id);
  } catch {
    return null;
  }
  const containerId = inspected?.ContainerID ?? inspected?.ContainerId;
  if (containerId !== issuedContainerId) return null;
  const container = await getAttestedContainer(containerId, policy, lookup);
  return container?.State?.Running === true && container.State?.Health?.Status === 'healthy' ? container : null;
}

export async function authorizeRequest(input, lookup = {}) {
  const policy = input.policy;
  if (!policy || !Array.isArray(policy.allowedImages) || !Array.isArray(policy.allowedNetworks)) return decision(false, 'policy_invalid');
  const route = parseRoute(input.url);
  if (!route) return decision(false, 'path_invalid');
  const method = String(input.method ?? '').toUpperCase();
  const upgrade = headerValue(input.headers, 'upgrade').toLowerCase();
  const connection = headerValue(input.headers, 'connection').toLowerCase();
  const hasUpgrade = Boolean(upgrade) || connection.split(',').some((entry) => entry.trim() === 'upgrade');
  if (hasAmbiguousBody(input, policy.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)) return decision(false, 'body_ambiguous');
  const body = parseBody(input.body);
  if (body === Symbol.for('invalid-json')) return decision(false, 'body_invalid');
  if (body !== null && ['GET', 'HEAD', 'DELETE'].includes(method)) return decision(false, 'body_unexpected');
  if ((Buffer.isBuffer(input.body) || typeof input.body === 'string') && Buffer.byteLength(input.body) > 0
    && !/^application\/json(?:;|$)/iu.test(headerValue(input.headers, 'content-type'))) {
    return decision(false, 'content_type_denied');
  }

  if (((route.normalizedPath === '/_ping' && (method === 'GET' || method === 'HEAD')) || (route.normalizedPath === '/version' && method === 'GET'))
    && exactQuery(route.searchParams, new Set())) {
    return hasUpgrade ? decision(false, 'upgrade_denied') : decision(true, 'daemon_probe');
  }

  const image = route.normalizedPath.match(/^\/images\/([^/]+)\/json$/u);
  if (image && method === 'GET' && policy.allowedImages.includes(image[1]) && !hasUpgrade && exactQuery(route.searchParams, new Set())) return decision(true, 'image_inspect');

  if (route.normalizedPath === '/containers/create' && method === 'POST' && !hasUpgrade) {
    const name = singleQuery(route.searchParams, 'name');
    if (name && exactQuery(route.searchParams, new Set(['name'])) && verifyCreateBody(body, name, policy)) return decision(true, 'container_create', { targetId: name, lockKey: name });
    return decision(false, 'create_policy_denied');
  }

  const container = route.normalizedPath.match(/^\/containers\/([^/]+)\/(json|start|stop|logs|exec)$/u);
  if (container) {
    const [, id, action] = container;
    const attested = await getAttestedContainer(id, policy, lookup);
    if (!attested) return decision(false, 'container_unattested');
    const canonicalId = attested.Id;
    const lockKey = String(attested.Name).replace(/^\//u, '');
    const mountSentinelHostPath = sentinelHostPath(attested, policy);
    if (action === 'json' && method === 'GET' && !hasUpgrade && exactQuery(route.searchParams, new Set())) return decision(true, 'container_inspect', { targetId: canonicalId, lockKey, mountSentinelHostPath });
    if (action === 'start' && method === 'POST' && !hasUpgrade && body === null && exactQuery(route.searchParams, new Set())) return decision(true, 'container_start', { targetId: canonicalId, lockKey, mountSentinelHostPath });
    if (action === 'stop' && method === 'POST' && !hasUpgrade && body === null
      && exactQuery(route.searchParams, new Set(['t']))
      && boundedQueryInteger(route.searchParams, 't', 0, 30)) return decision(true, 'container_stop', { targetId: canonicalId, lockKey, mountSentinelHostPath });
    if (action === 'logs' && method === 'GET' && !hasUpgrade && exactQuery(route.searchParams, new Set(['stdout', 'stderr', 'tail', 'since', 'until', 'timestamps', 'details']))) return decision(true, 'container_logs', { targetId: canonicalId, lockKey, mountSentinelHostPath });
    if (action === 'exec' && method === 'POST' && !hasUpgrade && exactQuery(route.searchParams, new Set()) && verifyExecBody(body)) {
      return attested.State?.Running === true && attested.State?.Health?.Status === 'healthy'
        ? decision(true, 'exec_create', { targetId: canonicalId, lockKey, mountSentinelHostPath })
        : decision(false, 'container_unhealthy');
    }
    return decision(false, 'container_action_denied');
  }

  const remove = route.normalizedPath.match(/^\/containers\/([^/]+)$/u);
  if (remove && method === 'DELETE' && !hasUpgrade) {
    const attested = await getAttestedContainer(remove[1], policy, lookup);
    const force = singleQuery(route.searchParams, 'force');
    return attested && exactQuery(route.searchParams, new Set(['force'])) && force === '1'
      ? decision(true, 'container_remove', { targetId: attested.Id, lockKey: String(attested.Name).replace(/^\//u, ''), mountSentinelHostPath: sentinelHostPath(attested, policy) })
      : decision(false, 'container_unattested');
  }

  const exec = route.normalizedPath.match(/^\/exec\/([^/]+)\/(start|json|resize)$/u);
  if (exec) {
    const [, id, action] = exec;
    const attested = await getAttestedIssuedExec(id, policy, lookup);
    if (!attested) return decision(false, 'exec_unissued');
    const target = { execId: id, targetId: attested.Id, lockKey: String(attested.Name).replace(/^\//u, '') };
    if (action === 'start' && method === 'POST' && exactQuery(route.searchParams, new Set()) && verifyExecStartBody(body)) {
      if (hasUpgrade && upgrade !== 'tcp') return decision(false, 'upgrade_denied');
      return decision(true, 'exec_start', { ...target, upgrade: hasUpgrade });
    }
    if (action === 'json' && method === 'GET' && !hasUpgrade && exactQuery(route.searchParams, new Set())) return decision(true, 'exec_inspect', target);
    if (action === 'resize' && method === 'POST' && !hasUpgrade && body === null
      && exactQuery(route.searchParams, new Set(['h', 'w']))
      && boundedQueryInteger(route.searchParams, 'h', 1, 1000, true)
      && boundedQueryInteger(route.searchParams, 'w', 1, 1000, true)) return decision(true, 'exec_resize', target);
    return decision(false, 'exec_action_denied');
  }

  return decision(false, 'route_denied');
}

function dockerRequest(socketPath, method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({ socketPath, method, path: requestPath, headers: encoded ? { 'content-type': 'application/json', 'content-length': encoded.length } : {}, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const chunks = [];
      let length = 0;
      res.on('data', (chunk) => {
        length += chunk.length;
        if (length > DEFAULT_MAX_BODY_BYTES) req.destroy(new Error('Docker response too large'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode ?? 500, headers: res.headers, body: Buffer.concat(chunks) });
        } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Docker request timeout')));
    req.on('error', reject);
    if (encoded) req.end(encoded); else req.end();
  });
}

export function createGuardState() {
  return { issuedExecIds: new Map(), containerLocks: new Map() };
}

function rememberExec(state, execId, containerId, containerName) {
  const now = Date.now();
  for (const [id, entry] of state.issuedExecIds) if (entry.expiresAt <= now) state.issuedExecIds.delete(id);
  if (state.issuedExecIds.size >= MAX_EXEC_CAPABILITIES) {
    const oldest = state.issuedExecIds.keys().next().value;
    if (oldest) state.issuedExecIds.delete(oldest);
  }
  state.issuedExecIds.set(execId, { containerId, containerName, expiresAt: now + EXEC_CAPABILITY_TTL_MS });
}

function prepareCreateBody(body, policy) {
  const forwarded = structuredClone(body);
  const bind = forwarded.HostConfig.Binds.map(parseBind).find((entry) => entry?.target === '/workspace');
  const source = bind ? resolvedSource(bind.source, policy) : null;
  if (!source || !withinRoot(source, policy.workspaceRoots, policy)) throw new Error('workspace source rejected');
  let name;
  let hostPath;
  let descriptor;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    name = `.eden3-mount-attestation-${randomBytes(16).toString('hex')}`;
    hostPath = path.posix.join(source, name);
    try {
      descriptor = openSync(hostPath, 'wx', 0o444);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  if (descriptor === undefined) throw new Error('unable to reserve mount sentinel');
  closeSync(descriptor);
  // OpenClaw's Docker create request uses the daemon default (0). The guard,
  // as the sole Docker authority, upgrades the forwarded sandbox to the
  // reviewed kill-first score and postflight attests that exact value.
  forwarded.HostConfig.OomScoreAdj = 1000;
  forwarded.Labels['eden3.guard.mountSentinel'] = name;
  forwarded.Cmd = ['/bin/sh', '-c', MOUNT_CHECK_SCRIPT, 'eden3-mount-check', `/workspace/${name}`];
  forwarded.Healthcheck = {
    Test: ['CMD-SHELL', `test -f ${MOUNT_READY_PATH}`],
    Interval: 1_000_000_000,
    Timeout: 2_000_000_000,
    Retries: 1,
    StartPeriod: 0,
  };
  return { body: forwarded, sentinelHostPath: hostPath };
}

function unlinkSentinel(candidate) {
  if (!candidate) return;
  try {
    unlinkSync(candidate);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function waitForHealthyAttestation(id, policy, lookup) {
  const timeoutMs = policy.startAttestationTimeoutMs ?? START_ATTESTATION_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const attested = await getAttestedContainer(id, policy, lookup);
    if (!attested || attested.State?.Running !== true) return null;
    if (attested.State?.Health?.Status === 'healthy') return attested;
    await new Promise((resolve) => setTimeout(resolve, Math.min(START_ATTESTATION_POLL_MS, Math.max(1, deadline - Date.now()))));
  }
  return null;
}

async function withContainerLock(state, key, operation) {
  if (!key) return operation();
  const previous = state.containerLocks.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  state.containerLocks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (state.containerLocks.get(key) === tail) state.containerLocks.delete(key);
  }
}

function safeHeaders(headers) {
  const denied = new Set(['host', 'connection', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'transfer-encoding']);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !denied.has(key.toLowerCase())));
}

function makeLookup(socketPath, state) {
  const getJson = async (requestPath) => {
    const response = await dockerRequest(socketPath, 'GET', requestPath);
    if (response.statusCode !== 200) return null;
    return JSON.parse(response.body.toString('utf8'));
  };
  return {
    issuedExecIds: state.issuedExecIds,
    inspectContainer: (id) => getJson(`/containers/${encodeURIComponent(id)}/json`),
    inspectExec: (id) => getJson(`/exec/${encodeURIComponent(id)}/json`),
    inspectImage: (id) => getJson(`/images/${encodeURIComponent(id)}/json`),
  };
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > maxBytes) req.destroy(new Error('request body too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendDenied(res, statusCode, code) {
  const payload = Buffer.from(JSON.stringify({ message: `sandbox Docker request denied (${code})` }));
  res.writeHead(statusCode, { 'content-type': 'application/json', 'content-length': payload.length, 'cache-control': 'no-store' });
  res.end(payload);
}

function canonicalUpstreamPath(rawUrl, result) {
  if (result.code === 'container_create' || !result.targetId || !result.code.startsWith('container_') && result.code !== 'exec_create') return rawUrl;
  const question = rawUrl.indexOf('?');
  const rawPath = question === -1 ? rawUrl : rawUrl.slice(0, question);
  const query = question === -1 ? '' : rawUrl.slice(question);
  const rewritten = rawPath.replace(/(\/containers\/)[^/]+(?=\/|$)/u, `$1${result.targetId}`);
  return `${rewritten}${query}`;
}

export function createGuardServer({ policy, socketPath = '/var/run/docker.sock', state = createGuardState() }) {
  state.containerLocks ??= new Map();
  const lookup = makeLookup(socketPath, state);
  const server = http.createServer(async (req, res) => {
    const requestStartedAt = Date.now();
    try {
      const body = await readBody(req, policy.maxBodyBytes);
      const requestInput = { method: req.method, url: req.url, headers: req.headers, body, policy };
      const initial = await authorizeRequest(requestInput, lookup);
      if (!initial.allowed) {
        if (initial.code === 'create_policy_denied') {
          process.stdout.write(`${JSON.stringify({
            event: 'sandbox_create_policy_denied',
            shape: summarizeSandboxCreateDenial(parseBody(body), singleQuery(parseRoute(req.url)?.searchParams ?? new URLSearchParams(), 'name'), policy),
          })}\n`);
        }
        return sendDenied(res, 403, initial.code);
      }
      await withContainerLock(state, initial.lockKey, async () => {
        const result = initial.lockKey ? await authorizeRequest(requestInput, lookup) : initial;
        if (!result.allowed || result.targetId !== initial.targetId) return sendDenied(res, 403, 'reauthorization_failed');
        const upstreamPath = canonicalUpstreamPath(req.url, result);
        let preparedCreate;
        let forwardedBody = body.length ? JSON.parse(body.toString('utf8')) : undefined;
        if (result.code === 'container_create') {
          preparedCreate = prepareCreateBody(forwardedBody, policy);
          forwardedBody = preparedCreate.body;
        }
        let upstream;
        try {
          upstream = await dockerRequest(socketPath, req.method, upstreamPath, forwardedBody);
        } catch (error) {
          unlinkSentinel(preparedCreate?.sentinelHostPath);
          throw error;
        }
        let responseBody = upstream.body;
        if (result.code === 'container_create') {
          if (upstream.statusCode >= 200 && upstream.statusCode < 300) {
            const containerId = JSON.parse(responseBody.toString('utf8'))?.Id;
            const attested = SAFE_SEGMENT.test(containerId ?? '') ? await getAttestedContainer(containerId, policy, lookup) : null;
            if (!attested) {
              process.stdout.write(`${JSON.stringify({
                event: 'sandbox_create_postflight_denied',
                ...await containerPostflightDenialReport(containerId, policy, lookup),
              })}\n`);
              if (SAFE_SEGMENT.test(containerId ?? '')) {
                await dockerRequest(socketPath, 'DELETE', `/containers/${containerId}?force=1`).catch(() => undefined);
              }
              unlinkSentinel(preparedCreate?.sentinelHostPath);
              return sendDenied(res, 502, 'create_postflight_failed');
            }
            process.stdout.write(`${JSON.stringify({
              event: 'sandbox_create_completed',
              elapsedMs: Math.max(0, Date.now() - requestStartedAt),
            })}\n`);
          } else {
            unlinkSentinel(preparedCreate?.sentinelHostPath);
          }
        }
        if (result.code === 'container_start' && upstream.statusCode >= 200 && upstream.statusCode < 400) {
          const attested = await waitForHealthyAttestation(result.targetId, policy, lookup);
          if (!attested) {
            await dockerRequest(socketPath, 'DELETE', `/containers/${result.targetId}?force=1`).catch(() => undefined);
            unlinkSentinel(result.mountSentinelHostPath);
            return sendDenied(res, 502, 'start_postflight_failed');
          }
          process.stdout.write(`${JSON.stringify({
            event: 'sandbox_start_completed',
            elapsedMs: Math.max(0, Date.now() - requestStartedAt),
          })}\n`);
        }
        if (result.code === 'exec_create' && upstream.statusCode >= 200 && upstream.statusCode < 300) {
          const execId = JSON.parse(responseBody.toString('utf8'))?.Id;
          if (!SAFE_SEGMENT.test(execId ?? '')) return sendDenied(res, 502, 'exec_response_invalid');
          rememberExec(state, execId, result.targetId, result.lockKey);
        }
        if (result.code === 'container_remove' && upstream.statusCode >= 200 && upstream.statusCode < 300) {
          for (const [execId, entry] of state.issuedExecIds) {
            if (entry.containerId === result.targetId) state.issuedExecIds.delete(execId);
          }
          unlinkSentinel(result.mountSentinelHostPath);
        }
        const headers = { ...safeHeaders(upstream.headers), 'content-length': responseBody.length, 'cache-control': 'no-store' };
        res.writeHead(upstream.statusCode, headers);
        res.end(responseBody);
      });
    } catch {
      if (!res.headersSent) sendDenied(res, 502, 'upstream_failed');
      else res.destroy();
    }
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 64;
  server.on('upgrade', (req, client, head) => {
    void (async () => {
      // Docker exec streaming is the sole permitted hijack. Buffer its small
      // start body before policy evaluation; never forward an ambiguous stream.
      const declared = Number(headerValue(req.headers, 'content-length'));
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > 4096 || headerValue(req.headers, 'transfer-encoding')) throw new Error('upgrade body rejected');
      let body = head;
      while (body.length < declared) {
        const chunk = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('upgrade body timeout')), 5000);
          client.once('data', (value) => { clearTimeout(timer); resolve(value); });
          client.once('error', reject);
        });
        body = Buffer.concat([body, chunk]);
      }
      if (body.length !== declared) throw new Error('upgrade body ambiguity');
      const result = await authorizeRequest({ method: req.method, url: req.url, headers: req.headers, body, policy }, lookup);
      if (!result.allowed || !result.upgrade) throw new Error(result.code);
      await withContainerLock(state, result.lockKey, async () => {
        const rechecked = await authorizeRequest({ method: req.method, url: req.url, headers: req.headers, body, policy }, lookup);
        if (!rechecked.allowed || rechecked.targetId !== result.targetId) throw new Error('upgrade reauthorization failed');
        const upstream = net.connect(socketPath);
        upstream.setTimeout(EXEC_STREAM_TIMEOUT_MS, () => upstream.destroy());
        await new Promise((resolve, reject) => { upstream.once('connect', resolve); upstream.once('error', reject); });
        const headers = { ...safeHeaders(req.headers), host: 'docker', connection: 'Upgrade', upgrade: 'tcp', 'content-length': body.length };
        upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
        upstream.write(body);
        client.pipe(upstream).pipe(client);
        const close = () => { client.destroy(); upstream.destroy(); };
        client.setTimeout(EXEC_STREAM_TIMEOUT_MS, close);
        upstream.once('error', close);
        client.once('error', close);
      });
    })().catch(() => {
      if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
  });
  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const policy = policyFromEnv();
  const host = process.env.EDEN3_DOCKER_GUARD_HOST ?? '0.0.0.0';
  const port = boundedInteger(process.env.EDEN3_DOCKER_GUARD_PORT, 2375);
  const socketPath = process.env.EDEN3_DOCKER_SOCKET_PATH ?? '/var/run/docker.sock';
  createGuardServer({ policy, socketPath }).listen(port, host, () => {
    process.stdout.write(JSON.stringify({ event: 'sandbox_docker_guard_ready', port }) + '\n');
  });
}
