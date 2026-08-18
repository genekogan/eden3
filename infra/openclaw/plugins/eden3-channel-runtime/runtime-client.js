import {
  normalizeRuntimeCallbackAuthority,
  runtimeCallbackAuthorityInternals,
} from './runtime-callback-authority.js';

const DEFAULT_BASE_URL = runtimeCallbackAuthorityInternals.PRODUCTION_BASE_URL;
const MAX_RESPONSE_BYTES = 64 * 1024;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export class ChannelRuntimeClientError extends Error {
  constructor(code, status) {
    super('Eden channel runtime callback failed');
    this.name = 'ChannelRuntimeClientError';
    this.code = SAFE_ERROR_CODE.test(code ?? '') ? code : 'runtime_callback_failed';
    this.status = Number.isInteger(status) ? status : undefined;
  }
}

export function validateChannelRuntimeBaseUrl(raw, env = process.env) {
  try {
    return normalizeRuntimeCallbackAuthority(raw, env);
  } catch {
    throw new ChannelRuntimeClientError('invalid_runtime_url');
  }
}

function responseErrorCode(payload) {
  const candidate = payload?.error?.code ?? payload?.code;
  return typeof candidate === 'string' && SAFE_ERROR_CODE.test(candidate)
    ? candidate
    : 'runtime_callback_failed';
}

async function boundedJson(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new ChannelRuntimeClientError('runtime_response_too_large', response.status);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new ChannelRuntimeClientError('runtime_response_too_large', response.status);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ChannelRuntimeClientError('invalid_runtime_response', response.status);
  }
}

export function createChannelRuntimeClient(options = {}) {
  const env = options.env ?? process.env;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const baseUrl = validateChannelRuntimeBaseUrl(
    options.baseUrl ?? env.EDEN3_CHANNEL_RUNTIME_API_URL ?? DEFAULT_BASE_URL,
    env,
  );
  const bearer = options.bearer ?? env.OPENCLAW_GATEWAY_TOKEN;
  const defaultTimeoutMs = options.timeoutMs ?? 4_000;

  async function post(path, body, requestOptions = {}) {
    if (typeof fetchFn !== 'function') {
      throw new ChannelRuntimeClientError('runtime_transport_unavailable');
    }
    if (typeof bearer !== 'string' || bearer.length < 16 || bearer.length > 8_192) {
      throw new ChannelRuntimeClientError('runtime_auth_unavailable');
    }
    if (!/^\/channels\/runtime\/[A-Za-z0-9/_:-]+$/.test(path) || path.includes('..')) {
      throw new ChannelRuntimeClientError('invalid_runtime_path');
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      requestOptions.timeoutMs ?? defaultTimeoutMs,
    );
    timeout.unref?.();
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
        throw new ChannelRuntimeClientError('runtime_transport_unavailable');
      }
      const payload = await boundedJson(response);
      if (!response.ok || payload?.ok !== true) {
        throw new ChannelRuntimeClientError(responseErrorCode(payload), response.status);
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  function mediaUrl(relativePath) {
    if (typeof relativePath !== 'string' ||
        !/^\/media\/runtime\/voice\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9]{10}\/[0-9a-f]{64}\.ogg$/.test(relativePath)) {
      throw new ChannelRuntimeClientError('invalid_runtime_media_url');
    }
    return `${baseUrl}${relativePath}`;
  }

  return Object.freeze({ post, mediaUrl });
}

export const channelRuntimeClientInternals = {
  DEFAULT_BASE_URL,
  MAX_RESPONSE_BYTES,
};
