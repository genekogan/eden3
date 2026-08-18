import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const read = (relative) => readFile(`${REPO}${relative}`, 'utf8');

describe('hosted channel runtime infrastructure contract', () => {
  it('bakes and enables the production hook plugin on the pinned runtime', async () => {
    const [dockerfile, manifest, index, bridge, pairingOutbox] = await Promise.all([
      read('infra/openclaw/Dockerfile'),
      read('infra/openclaw/plugins/eden3-channel-runtime/openclaw.plugin.json'),
      read('infra/openclaw/plugins/eden3-channel-runtime/index.js'),
      read('infra/openclaw/plugins/eden3-channel-runtime/bridge.js'),
      read('infra/openclaw/plugins/eden3-channel-runtime/pairing-callback-outbox.js'),
    ]);
    expect(dockerfile).toMatch(
      /^FROM ghcr\.io\/openclaw\/openclaw:2026\.7\.1@sha256:[a-f0-9]{64}$/m,
    );
    expect(dockerfile).toContain(
      'plugins/eden3-channel-runtime /opt/eden3/openclaw-plugins/eden3-channel-runtime',
    );
    const parsedManifest = JSON.parse(manifest);
    expect(parsedManifest).toMatchObject({
      id: 'eden3-channel-runtime',
      activation: { onStartup: true },
      configSchema: {
        required: ['accounts'],
        additionalProperties: false,
        properties: {
          accounts: {
            type: 'array',
            items: {
              required: [
                'channel',
                'accountId',
                'connectionId',
                'agentId',
                'model',
                'agentRuntime',
              ],
              additionalProperties: false,
            },
          },
        },
      },
    });
    expect(JSON.stringify(parsedManifest.configSchema)).not.toMatch(/token|credential|secret/i);
    const accountSchema = parsedManifest.configSchema.properties.accounts.items;
    expect(accountSchema.properties.bindingId).toEqual({
      type: 'string',
      pattern:
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
    });
    expect(bridge).toContain('api.pluginConfig');
    for (const hook of [
      'message_received',
      'before_model_resolve',
      'before_prompt_build',
      'before_tool_call',
      'before_agent_run',
      'llm_output',
      'agent_end',
      'reply_payload_sending',
      'channel_pairing_requested',
      'gateway_start',
      'gateway_stop',
    ]) {
      expect(index).toContain(`api.on('${hook}'`);
    }
    expect(index).toMatch(
      /api\.on\('reply_payload_sending',[\s\S]*?timeoutMs:\s*90_000/,
    );
    expect(index).toContain('createDurablePairingCallbackOutbox()');
    expect(pairingOutbox).toContain("createCipheriv('aes-256-gcm'");
    expect(pairingOutbox).toContain("process.env.OPENCLAW_GATEWAY_TOKEN");
    expect(pairingOutbox).toContain("openSync(temp, 'wx', 0o600)");
    expect(pairingOutbox).not.toMatch(/console\.|log\(/);
    expect(bridge).toContain('/channels/runtime/turns/reserve');
    expect(bridge).toContain('/settle');
    expect(bridge).toContain('/refund');
  });
});
