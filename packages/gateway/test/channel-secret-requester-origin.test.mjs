import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { bindEdenChannelRequesterRefs } from '../../../infra/openclaw/channel-secret-requester-origin.mjs';

const connectionId = randomUUID();
const ref = {
  source: 'exec',
  provider: 'eden-channel-vault',
  id: `channel/${connectionId}.c1.AAAAAAAAAAAAAAAAAAAAAA`,
};
const sourceConfig = {
  bindings: [
    {
      agentId: 'agent-one',
      match: { channel: 'discord', accountId: 'runtime-one' },
    },
  ],
};

describe('pinned OpenClaw channel SecretRef config-origin binding', () => {
  it('binds one exact named-account credential to its unique agent route', () => {
    expect(
      bindEdenChannelRequesterRefs(
        [
          {
            ref,
            path: 'channels.discord.accounts.runtime-one.token',
          },
        ],
        sourceConfig,
      ),
    ).toEqual([
      {
        ...ref,
        __edenRequester: {
          id: ref.id,
          configPath: 'channels.discord.accounts.runtime-one.token',
          connectionId,
          channel: 'discord',
          runtimeAccountId: 'runtime-one',
          agentId: 'agent-one',
          credentialField: 'token',
        },
      },
    ]);
  });

  it.each([
    [
      'victim-first',
      [
        { ref, path: 'channels.discord.accounts.runtime-one.token' },
        { ref, path: 'channels.discord.accounts.attacker.token' },
      ],
    ],
    [
      'attacker-first',
      [
        { ref, path: 'channels.discord.accounts.attacker.token' },
        { ref, path: 'channels.discord.accounts.runtime-one.token' },
      ],
    ],
  ])('rejects one intact ref at multiple config origins (%s)', (_label, assignments) => {
    expect(() =>
      bindEdenChannelRequesterRefs(assignments, {
        bindings: [
          ...sourceConfig.bindings,
          {
            agentId: 'attacker-agent',
            match: { channel: 'discord', accountId: 'attacker' },
          },
        ],
      }),
    ).toThrow('cannot be assigned to multiple config origins');
  });

  it('rejects missing and duplicate route bindings before resolution', () => {
    const assignment = [{ ref, path: 'channels.discord.accounts.runtime-one.token' }];
    expect(() => bindEdenChannelRequesterRefs(assignment, { bindings: [] })).toThrow(
      'requires one exact channel account binding',
    );
    expect(() =>
      bindEdenChannelRequesterRefs(assignment, {
        bindings: [...sourceConfig.bindings, ...sourceConfig.bindings],
      }),
    ).toThrow('requires one exact channel account binding');
  });
});
