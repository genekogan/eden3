import {
  normalizeRuntimeCallbackAuthority,
  runtimeCallbackAuthorityInternals,
} from './runtime-callback-authority.js';

const DEFAULT_BASE_URL = runtimeCallbackAuthorityInternals.PRODUCTION_BASE_URL;
const MAX_RESPONSE_BYTES = 32 * 1024;
const MEDIA_FAILURE_PATH =
  /^\/media\/runtime\/authorizations\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\/fail$/;

export class MediaRuntimeClientError extends Error {
  constructor(code = 'media_runtime_failed') {
    super('Eden media runtime callback failed');
    this.name = 'MediaRuntimeClientError';
    this.code = /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'media_runtime_failed';
  }
}

function validateBaseUrl(raw, env) {
  try {
    return normalizeRuntimeCallbackAuthority(raw, env);
  } catch {
    throw new MediaRuntimeClientError('invalid_runtime_url');
  }
}

async function boundedJson(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new MediaRuntimeClientError('runtime_response_too_large');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new MediaRuntimeClientError('runtime_response_too_large');
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new MediaRuntimeClientError('invalid_runtime_response');
  }
}

export function createMediaRuntimeClient(options = {}) {
  const env = options.env ?? process.env;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const baseUrl = validateBaseUrl(
    options.baseUrl ?? env.EDEN3_CHANNEL_RUNTIME_API_URL ?? DEFAULT_BASE_URL,
    env,
  );
  const bearer = options.bearer ?? env.OPENCLAW_GATEWAY_TOKEN;

  async function post(path, body) {
    if (typeof fetchFn !== 'function') throw new MediaRuntimeClientError('runtime_unavailable');
    if (typeof bearer !== 'string' || bearer.length < 16 || bearer.length > 8_192) {
      throw new MediaRuntimeClientError('runtime_auth_unavailable');
    }
    if (
      path !== '/media/runtime/authorizations' &&
      !MEDIA_FAILURE_PATH.test(path)
    ) {
      throw new MediaRuntimeClientError('invalid_runtime_path');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    timer.unref?.();
    try {
      let response;
      try {
        response = await fetchFn(`${baseUrl}${path}`, {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${bearer}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        throw new MediaRuntimeClientError('runtime_unavailable');
      }
      const payload = await boundedJson(response);
      if (!response.ok || payload?.ok !== true) {
        throw new MediaRuntimeClientError(payload?.error?.code ?? payload?.code);
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({ post });
}
