const PRODUCTION_BASE_URL = 'http://host.docker.internal:4312';
const LEGACY_GATE3_BASE_URL = 'http://host.docker.internal:14343';
const ISOLATED_HARNESS_MODE = 'isolated-harness';
const PROTECTED_PORTS = new Set([4300, 4301, 18789]);

export function normalizeRuntimeCallbackAuthority(raw, env = process.env) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('invalid_runtime_url');
  }

  const port = Number(parsed.port);
  const exactOrigin = `http://host.docker.internal:${port}`;
  const structurallySafe =
    parsed.protocol === 'http:' &&
    parsed.hostname === 'host.docker.internal' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.pathname === '/' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    Number.isSafeInteger(port) &&
    port >= 1024 &&
    port <= 65535 &&
    !PROTECTED_PORTS.has(port) &&
    parsed.origin === exactOrigin;

  if (raw === PRODUCTION_BASE_URL || raw === `${PRODUCTION_BASE_URL}/`) {
    return PRODUCTION_BASE_URL;
  }
  if (raw === LEGACY_GATE3_BASE_URL || raw === `${LEGACY_GATE3_BASE_URL}/`) {
    return LEGACY_GATE3_BASE_URL;
  }
  if (env.EDEN3_RUNTIME_CALLBACK_MODE === ISOLATED_HARNESS_MODE && structurallySafe) {
    return exactOrigin;
  }
  throw new Error('invalid_runtime_url');
}

export const runtimeCallbackAuthorityInternals = Object.freeze({
  ISOLATED_HARNESS_MODE,
  LEGACY_GATE3_BASE_URL,
  PRODUCTION_BASE_URL,
});
