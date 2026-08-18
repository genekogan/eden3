import { describe, expect, it, vi } from 'vitest';

import { ChannelConnectionQuotaExceededError } from '../src/services/channel-connection-quota.js';

import {
  FetchTelegramManagedBotApiClient,
  TelegramManagedBotError,
  TelegramManagedBotLifecycle,
  TelegramManagedBotsService,
  assertTelegramManagedBotTransition,
  createTelegramManagedBotDeepLink,
  normalizeTelegramManagedBotUpdate,
  type TelegramManagedBotCustodyLike,
} from '../src/services/telegram-managed-bots.js';

const MANAGED_BOT_TOKEN = ['987654321', 'm'.repeat(40)].join(':');
const MANAGER_BOT_TOKEN = ['123456789', 'r'.repeat(40)].join(':');
const CONNECTION_ID = '123e4567-e89b-42d3-a456-426614174000';
const SECRET_REF = {
  source: 'exec' as const,
  provider: 'eden-channel-vault' as const,
  id: `channel/${CONNECTION_ID}.c1.ABCDEFGHIJKLMNOPQRSTUV`,
};

function managedBotUpdate() {
  return {
    user: { id: 9007199254740001, is_bot: false, first_name: 'Alex', username: 'ExampleUser' },
    bot: {
      id: 9007199254740002,
      is_bot: true,
      first_name: 'Eden Helper',
      username: 'Eden_Helper_Bot',
    },
  };
}

describe('Telegram managed-bot deep links', () => {
  it('normalizes usernames, appends the bot suffix, and encodes the suggested name', () => {
    expect(
      createTelegramManagedBotDeepLink({
        managerBotUsername: '@EdenManagerBot',
        suggestedBotUsername: '@ExampleHelper',
        suggestedBotName: 'Example & Eden',
      }),
    ).toBe('https://t.me/newbot/EdenManagerBot/ExampleHelperbot?name=Example+%26+Eden');
  });

  it.each([
    [{ managerBotUsername: 'not a username' }, 'manager_bot_username_invalid'],
    [
      { managerBotUsername: 'EdenManagerBot', suggestedBotUsername: 'bad-name' },
      'managed_bot_username_invalid',
    ],
    [
      { managerBotUsername: 'EdenManagerBot', suggestedBotName: ' '.repeat(2) },
      'managed_bot_name_invalid',
    ],
  ])('fails closed with an actionable code for invalid link input', (input, code) => {
    expect(() => createTelegramManagedBotDeepLink(input)).toThrowError(
      expect.objectContaining({ code }),
    );
  });
});

describe('FetchTelegramManagedBotApiClient', () => {
  it('exchanges a managed bot id through getManagedBotToken', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: MANAGED_BOT_TOKEN }), { status: 200 }),
    );
    const client = new FetchTelegramManagedBotApiClient({
      managerBotToken: MANAGER_BOT_TOKEN,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.getManagedBotToken('9007199254740002')).resolves.toBe(
      MANAGED_BOT_TOKEN,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.telegram.org/bot${MANAGER_BOT_TOKEN}/getManagedBotToken`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: '9007199254740002' }),
        redirect: 'error',
      }),
    );
  });

  it.each([
    [401, 'manager_bot_credentials_invalid', false],
    [429, 'telegram_rate_limited', true],
    [503, 'telegram_unavailable', true],
  ] as const)('maps HTTP %s to a safe actionable error', async (status, code, retryable) => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: false,
          description: `sensitive upstream detail ${MANAGER_BOT_TOKEN}`,
        }),
        { status },
      ),
    );
    const client = new FetchTelegramManagedBotApiClient({
      managerBotToken: MANAGER_BOT_TOKEN,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const error = await client.getManagedBotToken('9007199254740002').catch((caught) => caught);
    expect(error).toMatchObject({ code, retryable });
    expect(String(error)).not.toContain(MANAGER_BOT_TOKEN);
  });

  it('rejects malformed successful responses without leaking returned material', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: `bad ${MANAGED_BOT_TOKEN}` }), { status: 200 }),
    );
    const client = new FetchTelegramManagedBotApiClient({
      managerBotToken: MANAGER_BOT_TOKEN,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const error = await client.getManagedBotToken('9007199254740002').catch((caught) => caught);
    expect(error).toMatchObject({ code: 'telegram_response_invalid', retryable: true });
    expect(String(error)).not.toContain(MANAGED_BOT_TOKEN);
  });
});

describe('Telegram managed-bot metadata and custody', () => {
  it('validates and normalizes only non-secret metadata', () => {
    expect(normalizeTelegramManagedBotUpdate(managedBotUpdate())).toEqual({
      owner: { id: '9007199254740001', username: 'ExampleUser', displayName: 'Alex' },
      bot: {
        id: '9007199254740002',
        username: 'Eden_Helper_Bot',
        displayName: 'Eden Helper',
      },
    });
  });

  it.each([
    [{ user: { id: 1 }, bot: { id: 2, is_bot: false, username: 'EdenBot' } }],
    [{ user: { id: 1 }, bot: { id: 2, is_bot: true, username: 'not-a-bot' } }],
    [{ user: { id: 1 }, bot: { id: 'unsafe', is_bot: true, username: 'EdenBot' } }],
  ])('rejects malformed or non-bot updates', (input) => {
    expect(() => normalizeTelegramManagedBotUpdate(input)).toThrowError(
      expect.objectContaining({ code: 'managed_bot_update_invalid' }),
    );
  });

  it('passes the exchanged token directly into scoped encrypted custody and never returns it', async () => {
    const api = { getManagedBotToken: vi.fn(async () => MANAGED_BOT_TOKEN) };
    const custody: TelegramManagedBotCustodyLike = {
      storeManagedBotToken: vi.fn(async () => ({
        connectionId: CONNECTION_ID,
        runtimeAccountId: `eden-${CONNECTION_ID}`,
        secretRef: SECRET_REF,
        state: 'stored_inactive' as const,
      })),
    };
    const service = new TelegramManagedBotsService(api, custody);

    const result = await service.exchangeAndStore({
      ownerAccountId: '223e4567-e89b-42d3-a456-426614174000',
      expectedTelegramOwnerId: '9007199254740001',
      agentId: '323e4567-e89b-42d3-a456-426614174000',
      label: 'Example helper',
      update: managedBotUpdate(),
    });

    expect(api.getManagedBotToken).toHaveBeenCalledWith('9007199254740002');
    expect(custody.storeManagedBotToken).toHaveBeenCalledWith(
      expect.objectContaining({
        plaintextToken: MANAGED_BOT_TOKEN,
        channel: 'telegram',
        bot: expect.objectContaining({ id: '9007199254740002' }),
      }),
    );
    expect(result).toMatchObject({
      connectionId: CONNECTION_ID,
      state: 'stored_inactive',
      bot: { id: '9007199254740002' },
    });
    expect(JSON.stringify(result)).not.toContain(MANAGED_BOT_TOKEN);
    expect(JSON.stringify(result)).not.toContain('channel/');
    expect(result).not.toHaveProperty('secretRef');
    expect(result).not.toHaveProperty('runtimeAccountId');
  });

  it('rejects custody results that do not consume request-scoping@v1', async () => {
    const service = new TelegramManagedBotsService(
      { getManagedBotToken: async () => MANAGED_BOT_TOKEN },
      {
        storeManagedBotToken: async () => ({
          connectionId: CONNECTION_ID,
          runtimeAccountId: `eden-${CONNECTION_ID}`,
          secretRef: {
            source: 'exec',
            provider: 'eden-channel-vault',
            id: `channel/${CONNECTION_ID}`,
          },
          state: 'stored_inactive',
        }),
      },
    );

    await expect(
      service.exchangeAndStore({
        ownerAccountId: '223e4567-e89b-42d3-a456-426614174000',
        expectedTelegramOwnerId: '9007199254740001',
        update: managedBotUpdate(),
      }),
    ).rejects.toMatchObject({ code: 'channel_secret_scope_invalid', retryable: false });
  });

  it('wraps custody failure without putting either bot token in the error', async () => {
    const service = new TelegramManagedBotsService(
      { getManagedBotToken: async () => MANAGED_BOT_TOKEN },
      {
        storeManagedBotToken: async () => {
          throw new Error(`vault failed ${MANAGED_BOT_TOKEN}`);
        },
      },
    );

    const error = await service
      .exchangeAndStore({
        ownerAccountId: '223e4567-e89b-42d3-a456-426614174000',
        expectedTelegramOwnerId: '9007199254740001',
        update: managedBotUpdate(),
      })
      .catch((caught) => caught);
    expect(error).toMatchObject({ code: 'channel_custody_unavailable', retryable: true });
    expect(String(error)).not.toContain(MANAGED_BOT_TOKEN);
  });

  it('preserves the stable owner-quota refusal from encrypted custody', async () => {
    const service = new TelegramManagedBotsService(
      { getManagedBotToken: async () => MANAGED_BOT_TOKEN },
      {
        storeManagedBotToken: async () => {
          throw new ChannelConnectionQuotaExceededError(2);
        },
      },
    );

    await expect(
      service.exchangeAndStore({
        ownerAccountId: '223e4567-e89b-42d3-a456-426614174000',
        expectedTelegramOwnerId: '9007199254740001',
        update: managedBotUpdate(),
      }),
    ).rejects.toMatchObject({
      code: 'channel_quota_exceeded',
      retryable: false,
    });
  });

  it('binds a manager-bot update to the already paired Telegram owner', async () => {
    const api = { getManagedBotToken: vi.fn(async () => MANAGED_BOT_TOKEN) };
    const custody = { storeManagedBotToken: vi.fn() };
    const service = new TelegramManagedBotsService(api, custody);

    await expect(
      service.exchangeAndStore({
        ownerAccountId: '223e4567-e89b-42d3-a456-426614174000',
        expectedTelegramOwnerId: '111111111',
        update: managedBotUpdate(),
      }),
    ).rejects.toMatchObject({ code: 'managed_bot_owner_mismatch', retryable: false });
    expect(api.getManagedBotToken).not.toHaveBeenCalled();
    expect(custody.storeManagedBotToken).not.toHaveBeenCalled();
  });
});

describe('Telegram managed-bot lifecycle', () => {
  it.each([
    ['stored_inactive', 'activating'],
    ['activating', 'active'],
    ['stored_inactive', 'revoking'],
    ['active', 'revoking'],
    ['error', 'revoking'],
    ['revoking', 'revoked'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(assertTelegramManagedBotTransition(from, to)).toBe(to);
  });

  it.each([
    ['stored_inactive', 'active'],
    ['active', 'stored_inactive'],
    ['revoked', 'activating'],
    ['revoking', 'active'],
  ] as const)('rejects unsafe %s -> %s transitions', (from, to) => {
    expect(() => assertTelegramManagedBotTransition(from, to)).toThrowError(
      expect.objectContaining({ code: 'managed_bot_state_conflict' }),
    );
  });

  it('exposes stable status and retry hints without raw causes', () => {
    const error = new TelegramManagedBotError(
      'telegram_rate_limited',
      'Telegram is rate-limiting bot setup. Retry shortly.',
      true,
    );
    expect(error).toMatchObject({ code: 'telegram_rate_limited', retryable: true });
  });

  it('serializes activation through activating before publishing active', async () => {
    let state: 'stored_inactive' | 'activating' | 'active' = 'stored_inactive';
    const events: string[] = [];
    const lifecycle = new TelegramManagedBotLifecycle(
      {
        getOwnedState: async () => state,
        compareAndSet: async ({ from, to }) => {
          events.push(`store:${from}->${to}`);
          if (state !== from) return false;
          state = to as typeof state;
          return true;
        },
      },
      {
        activate: async () => {
          events.push('runtime:activate');
        },
        deactivate: async () => {
          events.push('runtime:deactivate');
        },
      },
    );

    await expect(
      lifecycle.activate({ ownerAccountId: 'owner', connectionId: CONNECTION_ID }),
    ).resolves.toEqual({ state: 'active', changed: true });
    expect(events).toEqual([
      'store:stored_inactive->activating',
      'runtime:activate',
      'store:activating->active',
    ]);
  });

  it('returns activation to inactive with a safe retryable error if runtime setup fails', async () => {
    let state: 'stored_inactive' | 'activating' = 'stored_inactive';
    const lifecycle = new TelegramManagedBotLifecycle(
      {
        getOwnedState: async () => state,
        compareAndSet: async ({ from, to }) => {
          if (state !== from) return false;
          state = to as typeof state;
          return true;
        },
      },
      {
        activate: async () => {
          throw new Error(`unsafe runtime cause ${MANAGED_BOT_TOKEN}`);
        },
        deactivate: async () => undefined,
      },
    );

    const error = await lifecycle
      .activate({ ownerAccountId: 'owner', connectionId: CONNECTION_ID })
      .catch((caught) => caught);
    expect(state).toBe('stored_inactive');
    expect(error).toMatchObject({ code: 'managed_bot_activation_failed', retryable: true });
    expect(String(error)).not.toContain(MANAGED_BOT_TOKEN);
  });

  it('durably enters revoking before cleanup and stays revoked if cleanup must retry', async () => {
    let state: 'active' | 'revoking' | 'revoked' = 'active';
    const events: string[] = [];
    const lifecycle = new TelegramManagedBotLifecycle(
      {
        getOwnedState: async () => state,
        compareAndSet: async ({ from, to }) => {
          events.push(`store:${from}->${to}`);
          if (state !== from) return false;
          state = to as typeof state;
          return true;
        },
      },
      {
        activate: async () => undefined,
        deactivate: async () => {
          events.push('runtime:deactivate');
          throw new Error(`unsafe cleanup cause ${MANAGED_BOT_TOKEN}`);
        },
      },
    );

    await expect(
      lifecycle.revoke({ ownerAccountId: 'owner', connectionId: CONNECTION_ID }),
    ).resolves.toEqual({ state: 'revoked', changed: true, warning: 'runtime_cleanup_pending' });
    expect(events).toEqual([
      'store:active->revoking',
      'runtime:deactivate',
      'store:revoking->revoked',
    ]);
  });

  it('makes repeated activation and revocation idempotent', async () => {
    let state: 'active' | 'revoked' = 'active';
    const runtime = { activate: vi.fn(), deactivate: vi.fn() };
    const lifecycle = new TelegramManagedBotLifecycle(
      {
        getOwnedState: async () => state,
        compareAndSet: async ({ from, to }) => {
          if (state !== from) return false;
          state = to as typeof state;
          return true;
        },
      },
      runtime,
    );

    await expect(
      lifecycle.activate({ ownerAccountId: 'owner', connectionId: CONNECTION_ID }),
    ).resolves.toEqual({ state: 'active', changed: false });
    state = 'revoked';
    await expect(
      lifecycle.revoke({ ownerAccountId: 'owner', connectionId: CONNECTION_ID }),
    ).resolves.toEqual({ state: 'revoked', changed: false });
    expect(runtime.activate).not.toHaveBeenCalled();
    expect(runtime.deactivate).not.toHaveBeenCalled();
  });
});
