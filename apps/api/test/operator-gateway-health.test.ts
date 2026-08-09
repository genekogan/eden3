import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { probeOperatorGatewayModels } from '../src/routes/operator';

const source = readFileSync(new URL('../src/routes/operator.ts', import.meta.url), 'utf8');

function gatewayHandlerWiringErrors(input: string): string[] {
  const start = input.indexOf("app.get('/health'");
  const end = input.indexOf('const egressProxy', start);
  if (start < 0 || end < 0) return ['missing-gateway-handler-slice'];
  const gateway = input.slice(start, end);
  const errors: string[] = [];
  const calls = gateway.match(/probeOperatorGatewayModels\(\{/g) ?? [];
  if (calls.length !== 1) errors.push(`probe-call-count=${calls.length}`);
  for (const exact of [
    'baseUrl: getEnv().OPENCLAW_BASE_URL',
    'token: getEnv().OPENCLAW_GATEWAY_TOKEN',
  ]) {
    if (!gateway.includes(exact)) errors.push(`missing:${exact}`);
  }
  const guard = gateway.indexOf('if (!app.gatewayCompat)');
  const probe = gateway.indexOf('probeOperatorGatewayModels({');
  const configRead = gateway.indexOf('readOpenClawConfig(dataDir)');
  if (guard < 0 || probe < 0 || configRead < 0 || !(guard < probe && probe < configRead)) {
    errors.push('gateway-guard-probe-config-order');
  }
  for (const forbidden of ['fetch(', 'authorization', 'process.env.OPENCLAW']) {
    if (gateway.includes(forbidden)) errors.push(`forbidden:${forbidden}`);
  }
  return errors;
}

describe('operator gateway health credential boundary', () => {
  it.each([
    'https://attacker.invalid',
    'http://127.0.0.1.attacker.invalid:18789',
    'http://169.254.169.254:80',
    'http://user:pass@127.0.0.1:18789',
    'http://127.0.0.1:18789/base',
    'http://127.0.0.1:18789?next=attacker',
    'http://127.0.0.1:18789#fragment',
    '//127.0.0.1:18789',
    'http://localhost:18789',
  ])('refuses hostile or ambiguous gateway origin %s before fetch', async (baseUrl) => {
    const fetchImpl = vi.fn();
    await expect(probeOperatorGatewayModels({
      baseUrl,
      token: 'fake-gateway-token',
      fetchImpl: fetchImpl as never,
    })).resolves.toMatchObject({ configured: true, reachable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the bearer only to the exact typed loopback models endpoint and refuses redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ data: [{ id: 'model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const result = await probeOperatorGatewayModels({
      baseUrl: 'http://127.0.0.1:28789',
      token: 'fake-gateway-token',
      fetchImpl: fetchImpl as never,
      now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(17),
    });

    expect(result).toEqual({
      configured: true,
      reachable: true,
      latencyMs: 7,
      routableModels: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:28789/v1/models');
    expect(init).toMatchObject({
      redirect: 'error',
      headers: { authorization: 'Bearer fake-gateway-token' },
    });
  });

  it('refuses missing token or base URL without a request or empty bearer', async () => {
    for (const input of [
      { baseUrl: '', token: 'fake-gateway-token' },
      { baseUrl: 'http://127.0.0.1:18789', token: undefined },
    ]) {
      const fetchImpl = vi.fn();
      await expect(probeOperatorGatewayModels({ ...input, fetchImpl: fetchImpl as never }))
        .resolves.toEqual({ configured: false });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('routes production health through typed canonical env and has no shadow override', () => {
    expect(source).toContain('getEnv().OPENCLAW_BASE_URL');
    expect(source).toContain('getEnv().OPENCLAW_GATEWAY_TOKEN');
    expect(source).toContain("redirect: 'error'");
    expect(source).not.toContain('OPENCLAW_GATEWAY_URL');
    expect(source).not.toContain("OPENCLAW_GATEWAY_TOKEN ?? ''");
    expect(gatewayHandlerWiringErrors(source)).toEqual([]);

    const bypassMutant = source.replace(
      /const probe = await probeOperatorGatewayModels\(\{[\s\S]*?\n\s*\}\);/,
      `const probe = await fetch(getEnv().OPENCLAW_BASE_URL + '/v1/models', {
          headers: { authorization: 'Bearer ' + getEnv().OPENCLAW_GATEWAY_TOKEN },
        });`,
    );
    expect(gatewayHandlerWiringErrors(bypassMutant)).not.toEqual([]);
    const guardRemovalMutant = source.replace(
      "if (!app.gatewayCompat) return { configured: false as const };",
      '',
    );
    expect(gatewayHandlerWiringErrors(guardRemovalMutant)).not.toEqual([]);
  });
});
