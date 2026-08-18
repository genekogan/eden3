import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EnvError, getEnv, loadEnv, resetEnvCache } from './env';

describe('loadEnv', () => {
  it('applies defaults when the source is empty', () => {
    const env = loadEnv({});
    expect(env.DATABASE_URL).toBe('postgresql://127.0.0.1:5432/eden3_local');
    expect(env.EDEN3_DATABASE_NAME).toBe('eden3_local');
    expect(env.OPENCLAW_BASE_URL).toBe('http://127.0.0.1:18789');
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(env.MEDIA_DIR).toBe(path.resolve('var', 'media'));
    expect(env.TRANSCRIPTION_AUDIO_DIR).toBe(path.resolve('var', 'transcriptions'));
    expect(env.VOICE_OUTPUT_DIR).toBe(path.resolve('var', 'voice-output'));
    // Same-origin relative default so stored media URLs aren't cross-origin.
    expect(env.MEDIA_BASE_URL).toBe('/media');
    expect(env.API_PORT).toBe(4301);
    expect(env.WEB_PORT).toBe(4300);
    expect(env.ADMIN_USERNAMES).toEqual([]);
    expect(env.AUTH_PROVIDER).toBe('dev');
    expect(env.EDEN3_DEV_ROUTES).toBe(false);
    expect(env.CLERK_SECRET_KEY).toBeUndefined();
    expect(env.CLERK_JWT_KEY).toBeUndefined();
    expect(env.CLERK_AUTHORIZED_PARTIES).toEqual([]);
    expect(env.CLERK_NEW_USER_SEED_MANNA).toBe(100);
    expect(env.CHANNEL_TOKEN_ENCRYPTION_KEY).toBeUndefined();
    expect(env.MAX_NATIVE_AGENTS_PER_USER).toBe(25);
    expect(env.MAX_SCHEDULED_TASKS_PER_USER).toBe(100);
    expect(env.MAX_CHANNEL_CONNECTIONS_PER_USER).toBe(20);
    expect(env.MAX_CONCURRENT_TURNS_PER_USER).toBe(2);
    expect(env.MAX_CONCURRENT_TURNS_GLOBAL).toBe(10);
    expect(env.MAX_QUEUED_TURNS_GLOBAL).toBe(50);
    expect(env.TURN_QUEUE_TIMEOUT_MS).toBe(30_000);
    expect(env.MAX_CONCURRENT_TURNS_BASIC).toBeUndefined();
    expect(env.MAX_CONCURRENT_TURNS_PRO).toBeUndefined();
    expect(env.MAX_CONCURRENT_TURNS_BELIEVER).toBeUndefined();
    expect(env.DAILY_MANNA_SPEND_CAP_PER_USER).toBe(10_000);
    expect(env.API_BODY_LIMIT_BYTES).toBe(1_000_000);
    expect(env.MEMORY_DREAM_SCHEDULER_INTERVAL_MS).toBe(60_000);
    expect(env.MEMORY_DREAM_HOUR_UTC).toBe(7);
    expect(env.API_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(env.API_RATE_LIMIT_MAX).toBe(600);
    expect(env.API_ACCOUNT_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(env.API_ACCOUNT_RATE_LIMIT_MAX).toBe(600);
    expect(env.CLERK_SIGNUP_RATE_LIMIT_WINDOW_MS).toBe(3_600_000);
    expect(env.CLERK_SIGNUP_RATE_LIMIT_MAX).toBe(3);
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.STRIPE_MODE).toBe('test');
    expect(env.STRIPE_WEBHOOK_SECRET).toBeUndefined();
    expect(env.STRIPE_MANNA_TOPUP_PRICE_ID).toBeUndefined();
    expect(env.STRIPE_MANNA_TOPUP_AMOUNT).toBe(10_000);
    expect(env.STRIPE_SUBSCRIPTION_BASIC_MONTHLY_MANNA).toBe(10_000);
    expect(env.STRIPE_SUBSCRIPTION_PRO_MONTHLY_MANNA).toBe(35_000);
    expect(env.STRIPE_SUBSCRIPTION_BELIEVER_MONTHLY_MANNA).toBe(100_000);
  });

  it('parses EDEN3_DEV_ROUTES as an explicit boolean flag', () => {
    expect(loadEnv({ EDEN3_DEV_ROUTES: '1' }).EDEN3_DEV_ROUTES).toBe(true);
    expect(loadEnv({ EDEN3_DEV_ROUTES: 'true' }).EDEN3_DEV_ROUTES).toBe(true);
    expect(loadEnv({ EDEN3_DEV_ROUTES: '0' }).EDEN3_DEV_ROUTES).toBe(false);
    expect(loadEnv({ EDEN3_DEV_ROUTES: 'false' }).EDEN3_DEV_ROUTES).toBe(false);
    expect(loadEnv({ EDEN3_DEV_ROUTES: '' }).EDEN3_DEV_ROUTES).toBe(false); // empty = unset
    expect(() => loadEnv({ EDEN3_DEV_ROUTES: 'yes' })).toThrow(EnvError);
  });

  it('uses provided values and coerces ports to numbers', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://u:p@example:5432/db',
      EDEN3_DATABASE_NAME: 'db',
      OPENCLAW_GATEWAY_TOKEN: 'secret-token',
      API_PORT: '9001',
      WEB_PORT: '9000',
      ADMIN_USERNAMES: ' alex, Eve ,,',
      AUTH_PROVIDER: 'hybrid',
      CLERK_SECRET_KEY: 'sk_test_clerk',
      CLERK_JWT_KEY: '-----BEGIN PUBLIC KEY-----\\nmock\\n-----END PUBLIC KEY-----',
      CLERK_AUTHORIZED_PARTIES: 'http://localhost:4300, https://app.example.test',
      CLERK_NEW_USER_SEED_MANNA: '42',
      CHANNEL_TOKEN_ENCRYPTION_KEY: 'base64-or-hex-key',
      MAX_NATIVE_AGENTS_PER_USER: '7',
      MAX_SCHEDULED_TASKS_PER_USER: '8',
      MAX_CHANNEL_CONNECTIONS_PER_USER: '9',
      MAX_CONCURRENT_TURNS_PER_USER: '3',
      MAX_CONCURRENT_TURNS_GLOBAL: '11',
      MAX_QUEUED_TURNS_GLOBAL: '51',
      TURN_QUEUE_TIMEOUT_MS: '45000',
      MAX_CONCURRENT_TURNS_BASIC: '4',
      MAX_CONCURRENT_TURNS_PRO: '5',
      MAX_CONCURRENT_TURNS_BELIEVER: '6',
      DAILY_MANNA_SPEND_CAP_PER_USER: '500',
      API_BODY_LIMIT_BYTES: '2048',
      API_RATE_LIMIT_WINDOW_MS: '1000',
      API_RATE_LIMIT_MAX: '10',
      API_ACCOUNT_RATE_LIMIT_WINDOW_MS: '2000',
      API_ACCOUNT_RATE_LIMIT_MAX: '20',
      CLERK_SIGNUP_RATE_LIMIT_WINDOW_MS: '3000',
      CLERK_SIGNUP_RATE_LIMIT_MAX: '2',
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_MODE: 'test',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      STRIPE_MANNA_TOPUP_PRICE_ID: 'price_topup',
      STRIPE_MANNA_TOPUP_AMOUNT: '1234',
      STRIPE_SUBSCRIPTION_BASIC_PRICE_ID: 'price_basic',
      STRIPE_SUBSCRIPTION_PRO_PRICE_ID: 'price_pro',
      STRIPE_SUBSCRIPTION_BELIEVER_PRICE_ID: 'price_believer',
      STRIPE_SUBSCRIPTION_BASIC_MONTHLY_MANNA: '111',
      STRIPE_SUBSCRIPTION_PRO_MONTHLY_MANNA: '222',
      STRIPE_SUBSCRIPTION_BELIEVER_MONTHLY_MANNA: '333',
      BILLING_SUCCESS_URL: 'http://localhost:4300/manna?checkout=success',
      BILLING_CANCEL_URL: 'http://localhost:4300/manna?checkout=cancel',
    });
    expect(env.DATABASE_URL).toBe('postgres://u:p@example:5432/db');
    expect(env.EDEN3_DATABASE_NAME).toBe('db');
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe('secret-token');
    expect(env.API_PORT).toBe(9001);
    expect(env.WEB_PORT).toBe(9000);
    expect(env.ADMIN_USERNAMES).toEqual(['alex', 'Eve']);
    expect(env.AUTH_PROVIDER).toBe('hybrid');
    expect(env.CLERK_SECRET_KEY).toBe('sk_test_clerk');
    expect(env.CLERK_JWT_KEY).toBe('-----BEGIN PUBLIC KEY-----\\nmock\\n-----END PUBLIC KEY-----');
    expect(env.CLERK_AUTHORIZED_PARTIES).toEqual(['http://localhost:4300', 'https://app.example.test']);
    expect(env.CLERK_NEW_USER_SEED_MANNA).toBe(42);
    expect(env.CHANNEL_TOKEN_ENCRYPTION_KEY).toBe('base64-or-hex-key');
    expect(env.MAX_NATIVE_AGENTS_PER_USER).toBe(7);
    expect(env.MAX_SCHEDULED_TASKS_PER_USER).toBe(8);
    expect(env.MAX_CHANNEL_CONNECTIONS_PER_USER).toBe(9);
    expect(env.MAX_CONCURRENT_TURNS_PER_USER).toBe(3);
    expect(env.MAX_CONCURRENT_TURNS_GLOBAL).toBe(11);
    expect(env.MAX_QUEUED_TURNS_GLOBAL).toBe(51);
    expect(env.TURN_QUEUE_TIMEOUT_MS).toBe(45_000);
    expect(env.MAX_CONCURRENT_TURNS_BASIC).toBe(4);
    expect(env.MAX_CONCURRENT_TURNS_PRO).toBe(5);
    expect(env.MAX_CONCURRENT_TURNS_BELIEVER).toBe(6);
    expect(env.DAILY_MANNA_SPEND_CAP_PER_USER).toBe(500);
    expect(env.API_BODY_LIMIT_BYTES).toBe(2048);
    expect(env.API_RATE_LIMIT_WINDOW_MS).toBe(1000);
    expect(env.API_RATE_LIMIT_MAX).toBe(10);
    expect(env.API_ACCOUNT_RATE_LIMIT_WINDOW_MS).toBe(2000);
    expect(env.API_ACCOUNT_RATE_LIMIT_MAX).toBe(20);
    expect(env.CLERK_SIGNUP_RATE_LIMIT_WINDOW_MS).toBe(3000);
    expect(env.CLERK_SIGNUP_RATE_LIMIT_MAX).toBe(2);
    expect(env.STRIPE_SECRET_KEY).toBe('sk_test_x');
    expect(env.STRIPE_MODE).toBe('test');
    expect(env.STRIPE_WEBHOOK_SECRET).toBe('whsec_x');
    expect(env.STRIPE_MANNA_TOPUP_PRICE_ID).toBe('price_topup');
    expect(env.STRIPE_MANNA_TOPUP_AMOUNT).toBe(1234);
    expect(env.STRIPE_SUBSCRIPTION_BASIC_PRICE_ID).toBe('price_basic');
    expect(env.STRIPE_SUBSCRIPTION_PRO_PRICE_ID).toBe('price_pro');
    expect(env.STRIPE_SUBSCRIPTION_BELIEVER_PRICE_ID).toBe('price_believer');
    expect(env.STRIPE_SUBSCRIPTION_BASIC_MONTHLY_MANNA).toBe(111);
    expect(env.STRIPE_SUBSCRIPTION_PRO_MONTHLY_MANNA).toBe(222);
    expect(env.STRIPE_SUBSCRIPTION_BELIEVER_MONTHLY_MANNA).toBe(333);
    expect(env.BILLING_SUCCESS_URL).toBe('http://localhost:4300/manna?checkout=success');
    expect(env.BILLING_CANCEL_URL).toBe('http://localhost:4300/manna?checkout=cancel');
  });

  it('treats empty strings as unset', () => {
    const env = loadEnv({ DATABASE_URL: '', OPENCLAW_GATEWAY_TOKEN: '' });
    expect(env.DATABASE_URL).toBe('postgresql://127.0.0.1:5432/eden3_local');
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
  });

  it('derives one logical DB selector and rejects an API/sidecar mismatch', () => {
    expect(loadEnv({ DATABASE_URL: 'postgres://u:p@localhost:5433/eden3_stg' }).EDEN3_DATABASE_NAME)
      .toBe('eden3_stg');
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5433/eden3_stg',
        EDEN3_DATABASE_NAME: 'eden3',
      }),
    ).toThrow(/EDEN3_DATABASE_NAME.*must match DATABASE_URL database "eden3_stg"/);
    expect(() => loadEnv({ DATABASE_URL: 'not-a-postgres-url' })).toThrow(/DATABASE_URL/);
    for (const databaseUrl of [
      'postgres://u:p@localhost:5433/scratch/../eden3',
      'postgres://u:p@localhost:5433/scratch/%2e%2e/eden3',
      'postgres://u:p@localhost:5433/./eden3',
      'postgres://u:p@localhost:5433/%65den3',
    ]) {
      expect(() => loadEnv({ DATABASE_URL: databaseUrl }), databaseUrl).toThrow(/DATABASE_URL/);
    }
  });

  it('throws EnvError on invalid values', () => {
    expect(() => loadEnv({ API_PORT: 'not-a-port' })).toThrow(EnvError);
    expect(() => loadEnv({ API_PORT: '70000' })).toThrow(EnvError);
    expect(() => loadEnv({ API_PORT: '0' })).toThrow(EnvError);
    expect(() => loadEnv({ MAX_NATIVE_AGENTS_PER_USER: '-1' })).toThrow(EnvError);
    expect(() => loadEnv({ MAX_SCHEDULED_TASKS_PER_USER: '-1' })).toThrow(EnvError);
    expect(() => loadEnv({ MAX_CHANNEL_CONNECTIONS_PER_USER: '-1' })).toThrow(EnvError);
    expect(() => loadEnv({ MAX_CONCURRENT_TURNS_PER_USER: '-1' })).toThrow(EnvError);
    expect(() => loadEnv({ MAX_CONCURRENT_TURNS_GLOBAL: '0' })).toThrow(EnvError);
    expect(() => loadEnv({ MAX_QUEUED_TURNS_GLOBAL: '-1' })).toThrow(EnvError);
    expect(() => loadEnv({ TURN_QUEUE_TIMEOUT_MS: '999' })).toThrow(EnvError);
    expect(() => loadEnv({ MAX_CONCURRENT_TURNS_PRO: '-1' })).toThrow(EnvError);
    expect(() => loadEnv({ DAILY_MANNA_SPEND_CAP_PER_USER: '-1' })).toThrow(EnvError);
    expect(() => loadEnv({ MEMORY_DREAM_SCHEDULER_INTERVAL_MS: '-1' })).toThrow(EnvError);
    expect(() => loadEnv({ MEMORY_DREAM_HOUR_UTC: '24' })).toThrow(EnvError);
    expect(() => loadEnv({ API_BODY_LIMIT_BYTES: '0' })).toThrow(EnvError);
    expect(() => loadEnv({ API_RATE_LIMIT_WINDOW_MS: '0' })).toThrow(EnvError);
    expect(() => loadEnv({ API_RATE_LIMIT_MAX: '-1' })).toThrow(EnvError);
    expect(() => loadEnv({ API_ACCOUNT_RATE_LIMIT_WINDOW_MS: '0' })).toThrow(EnvError);
    expect(() => loadEnv({ API_ACCOUNT_RATE_LIMIT_MAX: '-1' })).toThrow(EnvError);
    expect(() => loadEnv({ CLERK_SIGNUP_RATE_LIMIT_WINDOW_MS: '0' })).toThrow(EnvError);
    expect(() => loadEnv({ CLERK_SIGNUP_RATE_LIMIT_MAX: '-1' })).toThrow(EnvError);
    expect(() => loadEnv({ AUTH_PROVIDER: 'cookies' })).toThrow(EnvError);
    expect(() => loadEnv({ CLERK_NEW_USER_SEED_MANNA: '-1' })).toThrow(EnvError);
    expect(() => loadEnv({ STRIPE_MANNA_TOPUP_AMOUNT: '0' })).toThrow(EnvError);
    expect(() => loadEnv({ STRIPE_SUBSCRIPTION_BASIC_MONTHLY_MANNA: '-1' })).toThrow(EnvError);
    expect(() => loadEnv({ STRIPE_MODE: 'live' })).toThrow(/STRIPE_MODE.*test/);
    expect(() => loadEnv({ STRIPE_SECRET_KEY: 'sk_live_closed_doors' })).toThrow(
      /STRIPE_SECRET_KEY.*test-mode/,
    );
    expect(() =>
      loadEnv({ STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'rk_test_not_checkout_capable' }),
    ).toThrow(/STRIPE_SECRET_KEY.*sk_test_/);
    expect(() =>
      loadEnv({
        STRIPE_MANNA_TOPUP_PRICE_ID: 'price_duplicate',
        STRIPE_SUBSCRIPTION_BASIC_PRICE_ID: 'price_duplicate',
      }),
    ).toThrow(/STRIPE.*PRICE_ID.*unique/);
  });

  it('names the offending variable in the error message', () => {
    expect(() => loadEnv({ WEB_PORT: 'nope' })).toThrow(/WEB_PORT/);
  });

  it('requires all public, dictation, and voice roots to be symmetrically disjoint', () => {
    const roots = {
      MEDIA_DIR: '/tmp/eden3-roots/media',
      TRANSCRIPTION_AUDIO_DIR: '/tmp/eden3-roots/transcriptions',
      VOICE_OUTPUT_DIR: '/tmp/eden3-roots/voice',
    };
    expect(() => loadEnv({ ...roots, VOICE_OUTPUT_DIR: `${roots.MEDIA_DIR}/voice` })).toThrow(/VOICE_OUTPUT_DIR/);
    expect(() => loadEnv({ ...roots, MEDIA_DIR: `${roots.VOICE_OUTPUT_DIR}/media` })).toThrow(/VOICE_OUTPUT_DIR/);
    expect(() => loadEnv({ ...roots, TRANSCRIPTION_AUDIO_DIR: `${roots.VOICE_OUTPUT_DIR}/dictation` })).toThrow(/VOICE_OUTPUT_DIR/);
    expect(() => loadEnv({ ...roots, VOICE_OUTPUT_DIR: `${roots.TRANSCRIPTION_AUDIO_DIR}/voice` })).toThrow(/VOICE_OUTPUT_DIR/);
    expect(() => loadEnv(roots)).not.toThrow();
  });
});

describe('getEnv', () => {
  afterEach(() => {
    resetEnvCache();
    delete process.env.EDEN3_CORE_ENV_TEST_PORT;
  });

  it('caches until resetEnvCache is called', () => {
    resetEnvCache();
    const original = process.env.API_PORT;
    try {
      process.env.API_PORT = '5555';
      expect(getEnv().API_PORT).toBe(5555);
      process.env.API_PORT = '6666';
      expect(getEnv().API_PORT).toBe(5555); // cached
      resetEnvCache();
      expect(getEnv().API_PORT).toBe(6666);
    } finally {
      if (original === undefined) delete process.env.API_PORT;
      else process.env.API_PORT = original;
      resetEnvCache();
    }
  });
});
