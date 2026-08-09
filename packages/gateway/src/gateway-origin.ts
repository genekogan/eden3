import type { GatewayClientOptions } from './types';

export interface OpenClawGatewayAuthority {
  origin: string;
  token: string;
}

/**
 * Freeze the only authority that may receive the fleet OpenClaw bearer and
 * tenant payloads. Production binds OpenClaw to IPv4 loopback; an explicit
 * port keeps isolated stacks possible without admitting DNS, redirects, or
 * ambient URL paths.
 */
export function normalizeOpenClawGatewayAuthority(
  options: Pick<GatewayClientOptions, 'baseUrl' | 'token'>,
): OpenClawGatewayAuthority {
  if (options.token === '' || options.token.trim() !== options.token) {
    throw new TypeError('OpenClaw gateway token must be nonempty and canonical');
  }

  let parsed: URL;
  try {
    parsed = new URL(options.baseUrl);
  } catch {
    throw new TypeError('OpenClaw gateway origin is invalid');
  }

  const port = Number(parsed.port);
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port === '' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (options.baseUrl !== parsed.origin && options.baseUrl !== `${parsed.origin}/`)
  ) {
    throw new TypeError(
      'OpenClaw gateway origin must be an explicit IPv4 loopback HTTP origin',
    );
  }

  return Object.freeze({ origin: parsed.origin, token: options.token });
}
