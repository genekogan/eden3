import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  DailyCapExceededError,
  getEnv,
  InsufficientMannaError,
  resolveAgentByUsername,
  TurnCeilingError,
} from '@eden3/core';
import { channelConnections, db, pg, secretAccessAuditEvents } from '@eden3/db';
import {
  ensureHostedChannelAccount,
  removeHostedChannelAccount,
  type HostedChannelAccountOptions,
  type RemoveHostedChannelAccountOptions,
} from '@eden3/gateway';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ApiError, sendError } from '../errors';
import { defaultOpenclawDataDir } from '../gateway-glue';
import {
  ChannelTurnMeteringService,
  ChannelExecutionMismatchError,
  type ChannelTurnUsage,
} from '../services/channel-metering';
import {
  FetchChannelProviderClient,
  type ChannelProviderClientLike,
  type SupportedChannelProvider,
} from '../services/channel-provider';
import { addConnectionScopedPeer, decidePendingPairing } from '../services/channel-pairing';
import { isValidChannelRuntimeAuthorization } from '../services/channel-runtime-auth';
import {
  ChannelSessionSync,
  PostgresChannelSessionSyncStore,
  channelPeerFingerprint,
} from '../services/channel-session-sync';
import {
  channelPairingCodeSecretContext,
  channelPeerSecretContext,
  channelTokenSecretContext,
  defaultSecretVault,
  type SecretVaultLike,
} from '../services/secret-vault';

export interface ChannelRuntimeSyncLike {
  ensureHostedChannelAccount?(
    opts: Omit<HostedChannelAccountOptions, 'dataDir'>,
  ): Promise<{ changed: boolean }>;
  removeHostedChannelAccount?(
    opts: Omit<RemoveHostedChannelAccountOptions, 'dataDir'>,
  ): Promise<{ changed: boolean }>;
  /** Legacy test seam retained while callers migrate to named accounts. */
  ensureDiscordChannel?(opts: {
    tokenEnvVar: string;
    allowFrom: string[];
    bindAgentId?: string;
  }): Promise<{ changed: boolean }>;
}

export interface ChannelsRoutesOptions {
  vault?: SecretVaultLike;
  channelSync?: ChannelRuntimeSyncLike;
  providerClient?: ChannelProviderClientLike;
  sessionSync?: Pick<ChannelSessionSync, 'syncMessage'>;
  turnMetering?: Pick<
    ChannelTurnMeteringService,
    'reserve' | 'settle' | 'refund' | 'refundDeliveryFailure' | 'markDelivered'
  > &
    Partial<Pick<ChannelTurnMeteringService, 'refundStale'>>;
  runtimeToken?: string;
}

const channelSchema = z.enum(['discord', 'telegram']);
const paramsSchema = z.object({ id: z.string().uuid() });
const pairingParamsSchema = z.object({ id: z.string().uuid(), requestId: z.string().uuid() });
const turnParamsSchema = z.object({ turnId: z.string().uuid() });
const externalIdSchema = z.string().trim().regex(/^-?\d{3,25}$/);

const createConnectionBodySchema = z.object({
  channel: channelSchema,
  token: z.string().trim().min(1).max(20_000),
  label: z.string().trim().max(120).optional(),
  agentUsername: z.string().trim().min(1).max(200).optional(),
});

const guildSelectionSchema = z.object({
  guildId: z.string().regex(/^\d{3,25}$/),
  channelIds: z.array(z.string().regex(/^\d{3,25}$/)).max(100),
});

const connectionConfigSchema = z.object({
  dmPolicy: z.enum(['pairing', 'allowlist']).default('pairing'),
  allowFrom: z.array(externalIdSchema).max(100).default([]),
  discordGuilds: z.array(guildSelectionSchema).max(100).default([]),
});

const activationBodySchema = connectionConfigSchema
  .superRefine((value, ctx) => {
    if (value.dmPolicy === 'allowlist' && value.allowFrom.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowFrom'],
        message: 'allowlist policy requires at least one external user id',
      });
    }
    if (value.discordGuilds.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['discordGuilds'],
        message:
          'Discord guild/channel activation is disabled so shared transcripts cannot access private user memory',
      });
    }
  });

const retryBodySchema = z.object({
  token: z.string().trim().min(1).max(20_000).optional(),
});

const mockMessageBodySchema = z.object({ message: z.string().trim().min(1).max(4_000) });

const runtimeMessageSchema = z.object({
  connectionId: z.string().uuid(),
  runtimeAccountId: z.string().min(1).max(128),
  gatewaySessionKey: z.string().min(1).max(1_000),
  conversationId: z.string().trim().min(1).max(500).optional(),
  peerId: externalIdSchema,
  externalMessageId: z.string().min(1).max(500),
  role: z.enum(['user', 'assistant']),
  content: z.string().max(100_000),
  createdAt: z.string().datetime({ offset: true }),
  sourceSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

const runtimePairingSchema = z.object({
  connectionId: z.string().uuid(),
  runtimeAccountId: z.string().min(1).max(128),
  peerId: externalIdSchema,
  code: z.string().trim().min(1).max(128),
});

const approvePairingBodySchema = z
  .object({
    linkToMyAccount: z.boolean().default(false),
    pairingCode: z.string().trim().min(1).max(128).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.linkToMyAccount && !value.pairingCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pairingCode'],
        message: 'Pairing code is required to link this sender to your account',
      });
    }
  });

const runtimeStatusSchema = z.object({
  connectionId: z.string().uuid(),
  runtimeAccountId: z.string().min(1).max(128),
  state: z.enum(['live', 'stopped', 'error']),
  errorCode: z
    .enum(['invalid_token', 'provider_unavailable', 'gateway_disconnected', 'configuration_error'])
    .optional(),
});

const reserveTurnSchema = z.object({
  turnId: z.string().uuid(),
  connectionId: z.string().uuid(),
  runtimeAccountId: z.string().min(1).max(128),
  sessionId: z.string().uuid().optional(),
  externalMessageId: z.string().min(1).max(500).optional(),
});

const usageSchema = z
  .object({
    promptTokens: z.number().int().nonnegative().optional(),
    completionTokens: z.number().int().nonnegative().optional(),
    cachedTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .optional();

const settleTurnSchema = z.object({
  usage: usageSchema,
  provider: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(300),
  agentRuntime: z.enum(['openclaw', 'claude-cli']),
});

interface ChannelConnectionRow {
  id: string;
  account_id: string;
  agent_id: string | null;
  channel: SupportedChannelProvider;
  label: string | null;
  runtime_account_id: string | null;
  desired_state: 'inactive' | 'active';
  observed_state: string;
  status: string;
  token_ciphertext: string;
  token_iv: string;
  token_auth_tag: string;
  token_sha256: string;
  key_version: string;
  last_error_code: string | null;
  last_error_message: string | null;
  last_validated_at: string | null;
  retry_count: number;
  next_retry_at: string | null;
  activated_at: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

interface ConnectionConfig {
  dmPolicy: 'pairing' | 'allowlist';
  allowFrom: string[];
  discordGuilds: Array<{ guildId: string; channelIds: string[] }>;
}

interface EncryptedPairingCode {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
}

interface PairingDecisionMarker {
  requestId: string;
  nonce: string;
}

const SAFE_RUNTIME_ERRORS: Record<string, string> = {
  invalid_token: 'The provider rejected this bot token.',
  provider_unavailable: 'The channel provider is temporarily unavailable.',
  gateway_disconnected: 'The channel runtime disconnected.',
  configuration_error: 'The channel runtime could not apply this connection.',
};

function metadataRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function providerBotId(input: unknown): string | null {
  const bot = metadataRecord(input).bot;
  if (!bot || typeof bot !== 'object' || Array.isArray(bot)) return null;
  const id = (bot as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function channelCredentialLockKeys(params: {
  channel: SupportedChannelProvider;
  tokenSha256: string;
  botId: string | null;
}): string[] {
  return [
    `channel-credential-token:${params.channel}:${params.tokenSha256}`,
    ...(params.botId ? [`channel-credential-bot:${params.channel}:${params.botId}`] : []),
  ].sort();
}

function pairingCodeRecord(input: unknown): EncryptedPairingCode | null {
  const record = metadataRecord(input).pairingCode;
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const value = record as Record<string, unknown>;
  if (
    typeof value.ciphertext !== 'string' ||
    typeof value.iv !== 'string' ||
    typeof value.authTag !== 'string' ||
    typeof value.keyVersion !== 'string'
  ) {
    return null;
  }
  return {
    ciphertext: value.ciphertext,
    iv: value.iv,
    authTag: value.authTag,
    keyVersion: value.keyVersion,
  };
}

export function pairingCodesEqual(expected: string, actual: string): boolean {
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  const actualDigest = createHash('sha256').update(actual, 'utf8').digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

function pairingDecisionMarker(input: unknown): PairingDecisionMarker | null {
  const marker = metadataRecord(input)._pairingDecision;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
  const value = marker as Record<string, unknown>;
  return typeof value.requestId === 'string' && typeof value.nonce === 'string'
    ? { requestId: value.requestId, nonce: value.nonce }
    : null;
}

function samePairingDecisionMarker(
  input: unknown,
  expected: PairingDecisionMarker,
): boolean {
  const actual = pairingDecisionMarker(input);
  return actual?.requestId === expected.requestId && actual.nonce === expected.nonce;
}

function connectionConfig(input: unknown): ConnectionConfig {
  const metadata = metadataRecord(input);
  const raw = metadata.config;
  // Read legacy metadata tolerantly, but never project a stored guild
  // selection back into the hosted runtime. Hosted delivery is DM-only until
  // group-scoped memory and identity isolation exist end to end.
  const parsed = connectionConfigSchema.safeParse(raw);
  return parsed.success
    ? { ...parsed.data, discordGuilds: [] }
    : { dmPolicy: 'pairing', allowFrom: [], discordGuilds: [] };
}

function safeMetadata(input: unknown): {
  bot: { id: string | null; username: string | null; displayName: string | null } | null;
  config: ConnectionConfig;
} {
  const metadata = metadataRecord(input);
  const bot =
    metadata.bot && typeof metadata.bot === 'object' && !Array.isArray(metadata.bot)
      ? (metadata.bot as Record<string, unknown>)
      : null;
  const safeBot = bot
    ? {
        id: typeof bot.id === 'string' ? bot.id : null,
        username: typeof bot.username === 'string' ? bot.username : null,
        displayName: typeof bot.displayName === 'string' ? bot.displayName : null,
      }
    : null;
  return { bot: safeBot, config: connectionConfig(input) };
}

function dto(row: ChannelConnectionRow) {
  const safe = safeMetadata(row.metadata);
  return {
    id: row.id,
    accountId: row.account_id,
    agentId: row.agent_id,
    channel: row.channel,
    label: row.label,
    runtimeAccountId: row.runtime_account_id,
    status: row.status,
    desiredState: row.desired_state,
    observedState: row.observed_state,
    lastError:
      row.last_error_code
        ? { code: row.last_error_code, message: row.last_error_message ?? 'Connection error' }
        : null,
    lastValidatedAt: row.last_validated_at
      ? new Date(row.last_validated_at).toISOString()
      : null,
    retryCount: row.retry_count,
    nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at).toISOString() : null,
    activatedAt: row.activated_at ? new Date(row.activated_at).toISOString() : null,
    bot: safe.bot,
    config: { ...safe.config, deliveryScope: 'direct_messages_only' as const },
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const CONNECTION_COLUMNS = pg`
  id, account_id, agent_id, channel, label, runtime_account_id,
  desired_state, observed_state, status, token_ciphertext, token_iv,
  token_auth_tag, token_sha256, key_version,
  last_error_code, last_error_message, last_validated_at, retry_count,
  next_retry_at, activated_at, metadata, created_at, updated_at
`;

async function getOwnedConnection(
  id: string,
  accountId: string,
  isAdmin: boolean,
): Promise<ChannelConnectionRow | null> {
  const rows = await pg<ChannelConnectionRow[]>`
    select ${CONNECTION_COLUMNS}
    from channel_connections
    where id = ${id}
      ${isAdmin ? pg`` : pg`and account_id = ${accountId}`}
    limit 1
  `;
  return rows[0] ?? null;
}

async function audit(params: {
  actorAccountId: string | null;
  ownerAccountId: string;
  secretId: string;
  secretKind?: string;
  action: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(secretAccessAuditEvents).values({
    actorAccountId: params.actorAccountId,
    ownerAccountId: params.ownerAccountId,
    secretKind: params.secretKind ?? 'channel_token',
    secretId: params.secretId,
    action: params.action,
    metadata: params.metadata ?? null,
  });
}

async function quotaExceeded(accountId: string, isAdmin: boolean): Promise<boolean> {
  if (isAdmin) return false;
  const rows = await pg<{ count: number }[]>`
    select count(*)::int as count from channel_connections where account_id = ${accountId}
  `;
  return (rows[0]?.count ?? 0) >= getEnv().MAX_CHANNEL_CONNECTIONS_PER_USER;
}

function runtimeSync(opts: ChannelsRoutesOptions): Required<
  Pick<ChannelRuntimeSyncLike, 'ensureHostedChannelAccount' | 'removeHostedChannelAccount'>
> {
  return {
    ensureHostedChannelAccount:
      opts.channelSync?.ensureHostedChannelAccount ??
      ((input) => ensureHostedChannelAccount({ ...input, dataDir: defaultOpenclawDataDir() })),
    removeHostedChannelAccount:
      opts.channelSync?.removeHostedChannelAccount ??
      ((input) => removeHostedChannelAccount({ ...input, dataDir: defaultOpenclawDataDir() })),
  };
}

async function provisionedAgent(agentId: string): Promise<{ openclawId: string } | null> {
  const rows = await pg<{ openclaw_id: string | null }[]>`
    select openclaw_id from agents where account_id = ${agentId} limit 1
  `;
  return rows[0]?.openclaw_id ? { openclawId: rows[0].openclaw_id } : null;
}

function encryptedRecord(row: ChannelConnectionRow) {
  return {
    tokenCiphertext: row.token_ciphertext,
    tokenIv: row.token_iv,
    tokenAuthTag: row.token_auth_tag,
    keyVersion: row.key_version,
  };
}

function validationState(result: Awaited<ReturnType<ChannelProviderClientLike['validate']>>) {
  return result.ok
    ? {
        observedState: 'verified',
        status: 'connected',
        lastErrorCode: null,
        lastErrorMessage: null,
        retryCount: 0,
        nextRetryAt: null,
      }
    : {
        observedState: 'error',
        status: 'error',
        lastErrorCode: result.code,
        lastErrorMessage: result.message,
        retryCount: 1,
        nextRetryAt: result.retryable ? new Date(Date.now() + 60_000) : null,
      };
}

export const channelsRoutes: FastifyPluginAsync<ChannelsRoutesOptions> = async (app, opts) => {
  const vault: SecretVaultLike =
    opts.vault ??
    {
      encrypt(plaintext, context) {
        try {
          return defaultSecretVault().encrypt(plaintext, context);
        } catch (error) {
          throw new ApiError(
            503,
            'secret_vault_not_configured',
            error instanceof Error ? error.message : 'Secret vault is not configured',
          );
        }
      },
      decrypt(record, context) {
        try {
          return defaultSecretVault().decrypt(record, context);
        } catch (error) {
          throw new ApiError(
            503,
            'secret_vault_not_configured',
            error instanceof Error ? error.message : 'Secret vault is not configured',
          );
        }
      },
    };
  const providerClient = opts.providerClient ?? new FetchChannelProviderClient();
  const sync = runtimeSync(opts);
  const sessionSync =
    opts.sessionSync ?? new ChannelSessionSync(new PostgresChannelSessionSyncStore(), vault);
  const turnMetering = opts.turnMetering ?? new ChannelTurnMeteringService();
  const expectedRuntimeToken = opts.runtimeToken ?? getEnv().OPENCLAW_GATEWAY_TOKEN;

  const requireRuntime = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isValidChannelRuntimeAuthorization(req.headers.authorization, expectedRuntimeToken)) {
      return sendError(reply, 401, 'runtime_unauthorized', 'Runtime authorization required');
    }
  };

  app.get('/connections', { preHandler: app.requireAuth }, async (req) => {
    const account = req.account!;
    const rows = await pg<ChannelConnectionRow[]>`
      select ${CONNECTION_COLUMNS}
      from channel_connections
      where ${account.isAdmin ? pg`true` : pg`account_id = ${account.accountId}`}
      order by updated_at desc, id desc
    `;
    return { items: rows.map(dto) };
  });

  app.post('/connections', { preHandler: app.requireAuth }, async (req, reply) => {
    const account = req.account!;
    const body = createConnectionBodySchema.parse(req.body);
    if (await quotaExceeded(account.accountId, account.isAdmin)) {
      return sendError(
        reply,
        429,
        'channel_quota_exceeded',
        `Channel connection limit reached (${getEnv().MAX_CHANNEL_CONNECTIONS_PER_USER} connections)`,
      );
    }

    let agentId: string | null = null;
    if (body.agentUsername) {
      const resolved = await resolveAgentByUsername(body.agentUsername);
      if (!resolved) {
        return sendError(reply, 404, 'agent_not_found', `No agent named "${body.agentUsername}"`);
      }
      if (!account.isAdmin && resolved.agent.ownerId !== account.accountId) {
        return sendError(reply, 403, 'forbidden', 'Only the owner can attach this agent');
      }
      agentId = resolved.account.id;
    }

    const connectionId = randomUUID();
    const runtimeAccountId = `eden-${connectionId}`;
    const encrypted = vault.encrypt(
      body.token,
      channelTokenSecretContext({
        connectionId,
        accountId: account.accountId,
        channel: body.channel,
      }),
    );
    const validation = await providerClient.validate(body.channel, body.token);
    const state = validationState(validation);
    const metadata = {
      bot: validation.ok ? validation.bot : null,
      config: { dmPolicy: 'pairing', allowFrom: [], discordGuilds: [] },
    };
    const botId = validation.ok ? validation.bot.id : null;
    const rows = await pg.begin(async (tx) => {
      const lockKeys = [
        `channel-account:${account.accountId}`,
        ...channelCredentialLockKeys({
          channel: body.channel,
          tokenSha256: encrypted.tokenSha256,
          botId,
        }),
      ].sort();
      for (const lockKey of lockKeys) {
        await tx`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      }
      if (!account.isAdmin) {
        const counts = await tx<{ count: number }[]>`
          select count(*)::int as count
          from channel_connections
          where account_id = ${account.accountId}
        `;
        if ((counts[0]?.count ?? 0) >= getEnv().MAX_CHANNEL_CONNECTIONS_PER_USER) {
          throw new ApiError(
            429,
            'channel_quota_exceeded',
            `Channel connection limit reached (${getEnv().MAX_CHANNEL_CONNECTIONS_PER_USER} connections)`,
          );
        }
      }
      const conflicts = await tx<{ id: string }[]>`
        select id
        from channel_connections
        where channel = ${body.channel}
          and (
            token_sha256 = ${encrypted.tokenSha256}
            or (
              ${botId}::text is not null
              and metadata -> 'bot' ->> 'id' = ${botId}
            )
          )
        limit 1
      `;
      if (conflicts[0]) {
        throw new ApiError(
          409,
          'channel_credential_in_use',
          'This provider bot is already connected',
        );
      }
      return tx<ChannelConnectionRow[]>`
        insert into channel_connections (
          id, account_id, agent_id, channel, label, runtime_account_id,
          desired_state, observed_state, status, token_ciphertext, token_iv,
          token_auth_tag, token_sha256, key_version,
          last_error_code, last_error_message, last_validated_at, retry_count,
          next_retry_at, metadata
        ) values (
          ${connectionId}, ${account.accountId}, ${agentId}, ${body.channel},
          ${body.label ?? null}, ${runtimeAccountId}, 'inactive', ${state.observedState},
          ${state.status}, ${encrypted.tokenCiphertext}, ${encrypted.tokenIv},
          ${encrypted.tokenAuthTag}, ${encrypted.tokenSha256}, ${encrypted.keyVersion},
          ${state.lastErrorCode}, ${state.lastErrorMessage},
          now(), ${state.retryCount}, ${state.nextRetryAt?.toISOString() ?? null},
          ${tx.json(JSON.stringify(metadata))}
        )
        returning ${CONNECTION_COLUMNS}
      `;
    });
    const row = rows[0]!;
    await audit({
      actorAccountId: account.accountId,
      ownerAccountId: account.accountId,
      secretId: row.id,
      action: 'store',
      metadata: { channel: body.channel, agentId, validation: validation.ok ? 'valid' : validation.code },
    });
    return reply.code(201).send({ connection: dto(row) });
  });

  app.post('/connections/:id/retry', { preHandler: app.requireAuth }, async (req, reply) => {
    const account = req.account!;
    const { id } = paramsSchema.parse(req.params);
    const body = retryBodySchema.parse(req.body ?? {});
    const row = await getOwnedConnection(id, account.accountId, account.isAdmin);
    if (!row) return sendError(reply, 404, 'channel_connection_not_found', 'Connection not found');

    let token: string;
    let encrypted: ReturnType<SecretVaultLike['encrypt']> | null = null;
    if (body.token) {
      token = body.token;
      encrypted = vault.encrypt(
        token,
        channelTokenSecretContext({
          connectionId: row.id,
          accountId: row.account_id,
          channel: row.channel,
        }),
      );
    } else {
      await audit({
        actorAccountId: account.accountId,
        ownerAccountId: row.account_id,
        secretId: row.id,
        action: 'validate_retrieve',
        metadata: { channel: row.channel },
      });
      token = vault.decrypt(
        encryptedRecord(row),
        channelTokenSecretContext({
          connectionId: row.id,
          accountId: row.account_id,
          channel: row.channel,
        }),
      );
    }
    const validation = await providerClient.validate(row.channel, token);
    const state = validationState(validation);
    const nextTokenSha256 = encrypted?.tokenSha256 ?? row.token_sha256;
    const nextBotId = validation.ok ? validation.bot.id : null;
    let wasActive = row.desired_state === 'active';
    let metadata: Record<string, unknown> = metadataRecord(row.metadata);
    const rows = await pg.begin(async (tx) => {
      for (const lockKey of channelCredentialLockKeys({
        channel: row.channel,
        tokenSha256: nextTokenSha256,
        botId: nextBotId,
      })) {
        await tx`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      }
      const currentRows = await tx<ChannelConnectionRow[]>`
        select ${CONNECTION_COLUMNS}
        from channel_connections
        where id = ${row.id}
        for update
      `;
      const current = currentRows[0];
      if (!current) throw new ApiError(404, 'channel_connection_not_found', 'Connection not found');
      if (!encrypted && current.token_sha256 !== row.token_sha256) {
        throw new ApiError(409, 'channel_connection_changed', 'Connection changed; retry validation');
      }
      const conflicts = await tx<{ id: string }[]>`
        select id
        from channel_connections
        where id <> ${row.id}
          and channel = ${row.channel}
          and (
            token_sha256 = ${nextTokenSha256}
            or (
              ${nextBotId}::text is not null
              and metadata -> 'bot' ->> 'id' = ${nextBotId}
            )
          )
        limit 1
      `;
      if (conflicts[0]) {
        throw new ApiError(
          409,
          'channel_credential_in_use',
          'This provider bot is already connected',
        );
      }
      wasActive = current.desired_state === 'active';
      metadata = {
        ...metadataRecord(current.metadata),
        bot: validation.ok ? validation.bot : null,
      };
      return tx<ChannelConnectionRow[]>`
        update channel_connections
        set desired_state = ${!validation.ok ? 'inactive' : current.desired_state},
            observed_state = ${state.observedState}, status = ${state.status},
            last_error_code = ${state.lastErrorCode},
            last_error_message = ${state.lastErrorMessage}, last_validated_at = now(),
            retry_count = ${validation.ok ? 0 : current.retry_count + 1},
            next_retry_at = ${state.nextRetryAt?.toISOString() ?? null},
            metadata = ${tx.json(JSON.stringify(metadata))}, updated_at = now()
            ${encrypted
              ? tx`, token_ciphertext = ${encrypted.tokenCiphertext}, token_iv = ${encrypted.tokenIv},
                    token_auth_tag = ${encrypted.tokenAuthTag}, token_sha256 = ${encrypted.tokenSha256},
                    token_preview = null, key_version = ${encrypted.keyVersion}`
              : tx``}
        where id = ${row.id}
        returning ${CONNECTION_COLUMNS}
      `;
    });
    let fresh = rows[0]!;
    if (!validation.ok && wasActive && fresh.runtime_account_id) {
      try {
        await sync.removeHostedChannelAccount({
          channel: fresh.channel,
          runtimeAccountId: fresh.runtime_account_id,
          deleteAccount: false,
        });
      } catch {
        // The committed desired_state revocation already cuts off the SecretRef.
      }
    }
    // A revoked active token may have left the provider account stopped. A
    // successful retry/rotation deliberately toggles only this named account
    // so OpenClaw resolves the new vault value without disturbing other bots.
    if (
      validation.ok &&
      wasActive &&
      fresh.runtime_account_id &&
      fresh.agent_id
    ) {
      try {
        const agent = await provisionedAgent(fresh.agent_id);
        if (!agent) throw new Error('channel agent runtime unavailable');
        const config = connectionConfig(metadata);
        await sync.removeHostedChannelAccount({
          channel: fresh.channel,
          runtimeAccountId: fresh.runtime_account_id,
          deleteAccount: false,
        });
        await sync.ensureHostedChannelAccount({
          channel: fresh.channel,
          runtimeAccountId: fresh.runtime_account_id,
          connectionId: fresh.id,
          accountId: fresh.account_id,
          label: fresh.label,
          bindAgentId: agent.openclawId,
          dmPolicy: config.dmPolicy,
          allowFrom: config.allowFrom,
          discordGuilds: fresh.channel === 'discord' ? config.discordGuilds : [],
        });
        const restarted = await pg<ChannelConnectionRow[]>`
          update channel_connections
          set observed_state = 'starting', status = 'active', updated_at = now()
          where id = ${fresh.id}
          returning ${CONNECTION_COLUMNS}
        `;
        fresh = restarted[0] ?? fresh;
      } catch {
        const configurationErrorMessage = SAFE_RUNTIME_ERRORS.configuration_error!;
        try {
          await sync.removeHostedChannelAccount({
            channel: fresh.channel,
            runtimeAccountId: fresh.runtime_account_id!,
            deleteAccount: false,
          });
        } catch {
          // Revoking desired_state below keeps the SecretRef fail-closed.
        }
        await pg`
          update channel_connections
          set desired_state = 'inactive', observed_state = 'error', status = 'error',
              last_error_code = 'configuration_error',
              last_error_message = ${configurationErrorMessage}, updated_at = now()
          where id = ${fresh.id}
        `;
        throw new ApiError(502, 'configuration_error', configurationErrorMessage);
      }
    }
    await audit({
      actorAccountId: account.accountId,
      ownerAccountId: row.account_id,
      secretId: row.id,
      action: encrypted ? 'rotate' : 'validate',
      metadata: { channel: row.channel, result: validation.ok ? 'valid' : validation.code },
    });
    return { ok: validation.ok, connection: dto(fresh) };
  });

  app.get('/connections/:id/destinations', { preHandler: app.requireAuth }, async (req, reply) => {
    const account = req.account!;
    const { id } = paramsSchema.parse(req.params);
    const row = await getOwnedConnection(id, account.accountId, account.isAdmin);
    if (!row) return sendError(reply, 404, 'channel_connection_not_found', 'Connection not found');
    await audit({
      actorAccountId: account.accountId,
      ownerAccountId: row.account_id,
      secretId: row.id,
      action: 'destination_discovery',
      metadata: { channel: row.channel },
    });
    const token = vault.decrypt(
      encryptedRecord(row),
      channelTokenSecretContext({
        connectionId: row.id,
        accountId: row.account_id,
        channel: row.channel,
      }),
    );
    try {
      return { items: await providerClient.discoverDestinations(row.channel, token) };
    } catch {
      throw new ApiError(502, 'provider_unavailable', 'Provider destinations are unavailable');
    }
  });

  app.post('/connections/:id/activate', { preHandler: app.requireAuth }, async (req, reply) => {
    const account = req.account!;
    const { id } = paramsSchema.parse(req.params);
    const body = activationBodySchema.parse(req.body ?? {});
    const row = await getOwnedConnection(id, account.accountId, account.isAdmin);
    if (!row) return sendError(reply, 404, 'channel_connection_not_found', 'Connection not found');
    if (!row.agent_id || !row.runtime_account_id) {
      return sendError(reply, 409, 'channel_agent_required', 'Attach an agent before activation');
    }
    const agent = await provisionedAgent(row.agent_id);
    if (!agent) {
      return sendError(reply, 409, 'agent_not_provisioned', 'The attached agent has no runtime');
    }

    // Revalidate at the activation boundary so a token revoked after initial
    // storage never enters a gateway crash loop.
    await audit({
      actorAccountId: account.accountId,
      ownerAccountId: row.account_id,
      secretId: row.id,
      action: 'activate_validate_retrieve',
      metadata: { channel: row.channel },
    });
    const token = vault.decrypt(
      encryptedRecord(row),
      channelTokenSecretContext({
        connectionId: row.id,
        accountId: row.account_id,
        channel: row.channel,
      }),
    );
    const validation = await providerClient.validate(row.channel, token);
    if (!validation.ok) {
      if (row.desired_state === 'active' && row.runtime_account_id) {
        try {
          await sync.removeHostedChannelAccount({
            channel: row.channel,
            runtimeAccountId: row.runtime_account_id,
            deleteAccount: false,
          });
        } catch {
          // desired_state below revokes resolver access even if config cleanup fails.
        }
      }
      await pg`
        update channel_connections
        set desired_state = 'inactive', observed_state = 'error', status = 'error',
            last_error_code = ${validation.code},
            last_error_message = ${validation.message}, last_validated_at = now(),
            retry_count = retry_count + 1, updated_at = now()
        where id = ${row.id}
      `;
      return sendError(reply, 400, validation.code, validation.message);
    }

    const metadata = { bot: validation.bot, config: body };
    // Make the resolver record eligible immediately before publishing its
    // SecretRef. Otherwise a fast config watcher can ask the sidecar while the
    // row is still inactive and turn a valid activation into a crash loop.
    await pg.begin(async (tx) => {
      for (const lockKey of channelCredentialLockKeys({
        channel: row.channel,
        tokenSha256: row.token_sha256,
        botId: validation.bot.id,
      })) {
        await tx`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      }
      const current = await tx<{ token_sha256: string }[]>`
        select token_sha256
        from channel_connections
        where id = ${row.id}
        for update
      `;
      if (!current[0]) throw new ApiError(404, 'channel_connection_not_found', 'Connection not found');
      if (current[0].token_sha256 !== row.token_sha256) {
        throw new ApiError(409, 'channel_connection_changed', 'Connection changed; retry activation');
      }
      const conflicts = await tx<{ id: string }[]>`
        select id
        from channel_connections
        where id <> ${row.id}
          and channel = ${row.channel}
          and (
            token_sha256 = ${row.token_sha256}
            or metadata -> 'bot' ->> 'id' = ${validation.bot.id}
          )
        limit 1
      `;
      if (conflicts[0]) {
        throw new ApiError(
          409,
          'channel_credential_in_use',
          'This provider bot is already connected',
        );
      }
      await tx`
        update channel_connections
        set desired_state = 'active', observed_state = 'starting', status = 'active',
            last_error_code = null, last_error_message = null, last_validated_at = now(),
            retry_count = 0, next_retry_at = null,
            metadata = ${tx.json(JSON.stringify(metadata))}, updated_at = now()
        where id = ${row.id}
      `;
    });
    try {
      await sync.ensureHostedChannelAccount({
        channel: row.channel,
        runtimeAccountId: row.runtime_account_id,
        connectionId: row.id,
        accountId: row.account_id,
        label: row.label,
        bindAgentId: agent.openclawId,
        dmPolicy: body.dmPolicy,
        allowFrom: body.allowFrom,
        discordGuilds: row.channel === 'discord' ? body.discordGuilds : [],
      });
    } catch {
      const configurationErrorMessage = SAFE_RUNTIME_ERRORS.configuration_error!;
      try {
        await sync.removeHostedChannelAccount({
          channel: row.channel,
          runtimeAccountId: row.runtime_account_id,
          deleteAccount: false,
        });
      } catch {
        // The durable desired_state below still makes the resolver fail closed.
      }
      await pg`
        update channel_connections
        set desired_state = 'inactive', observed_state = 'error', status = 'error',
            last_error_code = 'configuration_error',
            last_error_message = ${configurationErrorMessage}, updated_at = now()
        where id = ${row.id}
      `;
      throw new ApiError(502, 'configuration_error', configurationErrorMessage);
    }
    const rows = await pg<ChannelConnectionRow[]>`
      update channel_connections
      set activated_at = now(), updated_at = now()
      where id = ${row.id}
      returning ${CONNECTION_COLUMNS}
    `;
    await audit({
      actorAccountId: account.accountId,
      ownerAccountId: row.account_id,
      secretId: row.id,
      action: 'activate',
      metadata: {
        channel: row.channel,
        runtimeAccountId: row.runtime_account_id,
        agentOpenclawId: agent.openclawId,
        dmPolicy: body.dmPolicy,
        allowFromCount: body.allowFrom.length,
        deliveryScope: 'direct_messages_only',
      },
    });
    return {
      ok: true,
      connection: dto(rows[0]!),
      runtime: { boundAgent: agent.openclawId, runtimeAccountId: row.runtime_account_id },
    };
  });

  app.post('/connections/:id/deactivate', { preHandler: app.requireAuth }, async (req, reply) => {
    const account = req.account!;
    const { id } = paramsSchema.parse(req.params);
    const row = await getOwnedConnection(id, account.accountId, account.isAdmin);
    if (!row) return sendError(reply, 404, 'channel_connection_not_found', 'Connection not found');
    // Revoke resolver eligibility first. Even if the config write fails, the
    // retained SecretRef can no longer retrieve plaintext for this account.
    await pg`
      update channel_connections
      set desired_state = 'inactive', observed_state = 'stopping', status = 'paused',
          last_error_code = null, last_error_message = null, updated_at = now()
      where id = ${row.id}
    `;
    if (row.runtime_account_id) {
      try {
        await sync.removeHostedChannelAccount({
          channel: row.channel,
          runtimeAccountId: row.runtime_account_id,
          deleteAccount: false,
        });
      } catch {
        const configurationErrorMessage = SAFE_RUNTIME_ERRORS.configuration_error!;
        await pg`
          update channel_connections
          set observed_state = 'error', status = 'error',
              last_error_code = 'configuration_error',
              last_error_message = ${configurationErrorMessage}, updated_at = now()
          where id = ${row.id}
        `;
        throw new ApiError(502, 'configuration_error', configurationErrorMessage);
      }
    }
    const rows = await pg<ChannelConnectionRow[]>`
      update channel_connections
      set desired_state = 'inactive', observed_state = 'stopped', status = 'paused',
          last_error_code = null, last_error_message = null, updated_at = now()
      where id = ${row.id}
      returning ${CONNECTION_COLUMNS}
    `;
    await audit({
      actorAccountId: account.accountId,
      ownerAccountId: row.account_id,
      secretId: row.id,
      action: 'deactivate',
      metadata: { channel: row.channel, runtimeAccountId: row.runtime_account_id },
    });
    return { ok: true, connection: dto(rows[0]!) };
  });

  app.delete('/connections/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const account = req.account!;
    const { id } = paramsSchema.parse(req.params);
    const row = await getOwnedConnection(id, account.accountId, account.isAdmin);
    if (!row) return sendError(reply, 404, 'channel_connection_not_found', 'Connection not found');
    // Deletion is fail-closed from the first durable write: any retained
    // SecretRef becomes unresolvable while refunds and exact-account cleanup
    // complete.
    await pg`
      update channel_connections
      set desired_state = 'inactive', observed_state = 'stopping', status = 'paused',
          updated_at = now()
      where id = ${row.id}
    `;
    const openTurns = await pg<{ turn_id: string }[]>`
      select turn_id from channel_turns
      where connection_id = ${row.id}
        and status in ('reserving', 'reserved', 'settling', 'error')
      order by created_at, turn_id
    `;
    for (const turn of openTurns) await turnMetering.refund(turn.turn_id);
    if (row.runtime_account_id) {
      try {
        await sync.removeHostedChannelAccount({
          channel: row.channel,
          runtimeAccountId: row.runtime_account_id,
          deleteAccount: true,
        });
      } catch {
        const configurationErrorMessage = SAFE_RUNTIME_ERRORS.configuration_error!;
        await pg`
          update channel_connections
          set observed_state = 'error', status = 'error',
              last_error_code = 'configuration_error',
              last_error_message = ${configurationErrorMessage}, updated_at = now()
          where id = ${row.id}
        `;
        throw new ApiError(502, 'configuration_error', configurationErrorMessage);
      }
    }
    await audit({
      actorAccountId: account.accountId,
      ownerAccountId: row.account_id,
      secretId: row.id,
      action: 'delete',
      metadata: { channel: row.channel, runtimeAccountId: row.runtime_account_id },
    });
    await db.delete(channelConnections).where(eq(channelConnections.id, row.id));
    return { ok: true };
  });

  // Retained as a custody/safety smoke seam; no provider message is sent.
  app.post('/connections/:id/mock-message', { preHandler: app.requireAuth }, async (req, reply) => {
    const account = req.account!;
    const { id } = paramsSchema.parse(req.params);
    const body = mockMessageBodySchema.parse(req.body);
    const row = await getOwnedConnection(id, account.accountId, account.isAdmin);
    if (!row) return sendError(reply, 404, 'channel_connection_not_found', 'Connection not found');
    return { ok: true, channel: row.channel, routed: true, messageLength: body.message.length };
  });

  app.get('/connections/:id/pairing', { preHandler: app.requireAuth }, async (req, reply) => {
    const account = req.account!;
    const { id } = paramsSchema.parse(req.params);
    const row = await getOwnedConnection(id, account.accountId, account.isAdmin);
    if (!row) return sendError(reply, 404, 'channel_connection_not_found', 'Connection not found');
    await pg`
      update channel_pairing_requests
      set status = 'expired', updated_at = now()
      where connection_id = ${row.id} and status = 'pending' and expires_at <= now()
    `;
    const items = await pg<
      Array<{
        id: string;
        status: string;
        peer_preview: string | null;
        requested_at: string;
        expires_at: string;
        decided_at: string | null;
      }>
    >`
      select p.id, p.status, i.peer_preview, p.requested_at, p.expires_at, p.decided_at
      from channel_pairing_requests p
      join channel_external_identities i on i.id = p.identity_id
      where p.connection_id = ${row.id}
      order by p.requested_at desc, p.id desc
      limit 100
    `;
    return {
      items: items.map((item) => ({
        id: item.id,
        status: item.status,
        peerPreview: item.peer_preview,
        requestedAt: new Date(item.requested_at).toISOString(),
        expiresAt: new Date(item.expires_at).toISOString(),
        decidedAt: item.decided_at ? new Date(item.decided_at).toISOString() : null,
      })),
    };
  });

  app.post(
    '/connections/:id/pairing/:requestId/approve',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const account = req.account!;
      const { id, requestId } = pairingParamsSchema.parse(req.params);
      const body = approvePairingBodySchema.parse(req.body ?? {});
      const connection = await getOwnedConnection(id, account.accountId, account.isAdmin);
      if (!connection) {
        return sendError(reply, 404, 'channel_connection_not_found', 'Connection not found');
      }
      if (connection.desired_state !== 'active') {
        return sendError(reply, 409, 'channel_connection_inactive', 'Activate the connection first');
      }
      if (!connection.agent_id || !connection.runtime_account_id) {
        return sendError(reply, 409, 'channel_agent_required', 'Connection has no runtime agent');
      }
      const agent = await provisionedAgent(connection.agent_id);
      if (!agent) return sendError(reply, 409, 'agent_not_provisioned', 'Agent has no runtime');
      const auditTargets = await pg<{ identity_id: string }[]>`
        select identity_id
        from channel_pairing_requests
        where id = ${requestId} and connection_id = ${connection.id}
        limit 1
      `;
      const auditTarget = auditTargets[0];
      if (!auditTarget) {
        return sendError(reply, 404, 'pairing_request_not_found', 'Request not found');
      }
      await audit({
        actorAccountId: account.accountId,
        ownerAccountId: connection.account_id,
        secretId: auditTarget.identity_id,
        secretKind: 'channel_peer',
        action: 'pairing_approve_retrieve',
        metadata: {
          channel: connection.channel,
          requestId,
          linkToMyAccount: body.linkToMyAccount,
        },
      });
      if (body.linkToMyAccount) {
        await audit({
          actorAccountId: account.accountId,
          ownerAccountId: connection.account_id,
          secretId: requestId,
          secretKind: 'channel_pairing_code',
          action: 'pairing_code_verify_retrieve',
          metadata: { channel: connection.channel, requestId },
        });
      }

      const marker: PairingDecisionMarker = { requestId, nonce: randomUUID() };
      const prepared = await pg.begin(async (tx) => {
        const connections = await tx<ChannelConnectionRow[]>`
          select ${CONNECTION_COLUMNS}
          from channel_connections
          where id = ${connection.id}
            ${account.isAdmin ? tx`` : tx`and account_id = ${account.accountId}`}
          for update
        `;
        const currentConnection = connections[0];
        if (!currentConnection) {
          throw new ApiError(404, 'channel_connection_not_found', 'Connection not found');
        }
        if (currentConnection.desired_state !== 'active') {
          throw new ApiError(409, 'channel_connection_inactive', 'Activate the connection first');
        }
        if (!currentConnection.agent_id || !currentConnection.runtime_account_id) {
          throw new ApiError(409, 'channel_agent_required', 'Connection has no runtime agent');
        }
        if (currentConnection.agent_id !== connection.agent_id) {
          throw new ApiError(409, 'channel_connection_changed', 'Connection changed; retry approval');
        }
        const requests = await tx<
          Array<{
            identity_id: string;
            status: string;
            expires_at: string;
            metadata: unknown;
            peer_ciphertext: string;
            peer_iv: string;
            peer_auth_tag: string;
            key_version: string;
            peer_fingerprint: string;
            linked_account_id: string | null;
          }>
        >`
          select p.identity_id, p.status, p.expires_at, p.metadata,
                 i.peer_ciphertext, i.peer_iv, i.peer_auth_tag, i.key_version,
                 i.peer_fingerprint, i.linked_account_id
          from channel_pairing_requests p
          join channel_external_identities i on i.id = p.identity_id
          where p.id = ${requestId} and p.connection_id = ${currentConnection.id}
          for update of p, i
        `;
        const pairing = requests[0];
        if (!pairing) {
          throw new ApiError(404, 'pairing_request_not_found', 'Request not found');
        }
        try {
          decidePendingPairing({
            status: pairing.status,
            expiresAt: new Date(pairing.expires_at),
            decision: 'approve',
          });
        } catch {
          throw new ApiError(
            409,
            'pairing_request_not_pending',
            'Request is no longer pending',
          );
        }
        if (
          body.linkToMyAccount &&
          pairing.linked_account_id &&
          pairing.linked_account_id !== account.accountId
        ) {
          throw new ApiError(
            409,
            'channel_identity_already_linked',
            'This sender is already linked to another account',
          );
        }
        if (body.linkToMyAccount) {
          const encryptedCode = pairingCodeRecord(pairing.metadata);
          if (!encryptedCode) {
            throw new ApiError(
              409,
              'pairing_code_unavailable',
              'This request cannot be linked; ask the bot for a new pairing code',
            );
          }
          const expectedCode = vault.decrypt(
            {
              tokenCiphertext: encryptedCode.ciphertext,
              tokenIv: encryptedCode.iv,
              tokenAuthTag: encryptedCode.authTag,
              keyVersion: encryptedCode.keyVersion,
            },
            channelPairingCodeSecretContext(
              currentConnection.id,
              pairing.peer_fingerprint,
            ),
          );
          if (!pairingCodesEqual(expectedCode, body.pairingCode!)) {
            throw new ApiError(403, 'pairing_code_invalid', 'Pairing code is incorrect');
          }
        }

        const peerId = vault.decrypt(
          {
            tokenCiphertext: pairing.peer_ciphertext,
            tokenIv: pairing.peer_iv,
            tokenAuthTag: pairing.peer_auth_tag,
            keyVersion: pairing.key_version,
          },
          channelPeerSecretContext(currentConnection.id, pairing.peer_fingerprint),
        );
        const oldConfig = connectionConfig(currentConnection.metadata);
        const allowFrom = addConnectionScopedPeer(oldConfig.allowFrom, peerId);
        const newConfig = { ...oldConfig, allowFrom };
        const oldConnectionMetadata = metadataRecord(currentConnection.metadata);
        const newConnectionMetadata = {
          ...oldConnectionMetadata,
          config: newConfig,
          _pairingDecision: marker,
        };
        const oldRequestMetadata = metadataRecord(pairing.metadata);
        const newRequestMetadata = {
          ...oldRequestMetadata,
          _decisionNonce: marker.nonce,
        };
        const claimed = await tx<{ id: string }[]>`
          update channel_pairing_requests
          set status = 'approved', decided_at = now(), decided_by_account_id = ${account.accountId},
              metadata = ${tx.json(JSON.stringify(newRequestMetadata))}, updated_at = now()
          where id = ${requestId} and status = 'pending' and expires_at > now()
          returning id
        `;
        if (!claimed[0]) {
          throw new ApiError(
            409,
            'pairing_request_not_pending',
            'Request is no longer pending',
          );
        }
        if (body.linkToMyAccount) {
          const linked = await tx<{ id: string }[]>`
            update channel_external_identities
            set linked_account_id = ${account.accountId}, updated_at = now()
            where id = ${pairing.identity_id}
              and (linked_account_id is null or linked_account_id = ${account.accountId})
            returning id
          `;
          if (!linked[0]) {
            throw new ApiError(
              409,
              'channel_identity_already_linked',
              'This sender is already linked to another account',
            );
          }
        }
        await tx`
          update channel_connections
          set metadata = ${tx.json(JSON.stringify(newConnectionMetadata))}, updated_at = now()
          where id = ${currentConnection.id}
        `;
        return {
          connection: currentConnection,
          identityId: pairing.identity_id,
          previousLinkedAccountId: pairing.linked_account_id,
          oldConfig,
          newConfig,
          oldConnectionMetadata,
          newConnectionMetadata,
          oldRequestMetadata,
          newRequestMetadata,
        };
      });

      try {
        await sync.ensureHostedChannelAccount({
          channel: prepared.connection.channel,
          runtimeAccountId: prepared.connection.runtime_account_id!,
          connectionId: prepared.connection.id,
          accountId: prepared.connection.account_id,
          label: prepared.connection.label,
          bindAgentId: agent.openclawId,
          dmPolicy: prepared.newConfig.dmPolicy,
          allowFrom: prepared.newConfig.allowFrom,
          discordGuilds:
            prepared.connection.channel === 'discord'
              ? prepared.newConfig.discordGuilds
              : [],
        });
      } catch (error) {
        let runtimeRestored = true;
        try {
          await sync.ensureHostedChannelAccount({
            channel: prepared.connection.channel,
            runtimeAccountId: prepared.connection.runtime_account_id!,
            connectionId: prepared.connection.id,
            accountId: prepared.connection.account_id,
            label: prepared.connection.label,
            bindAgentId: agent.openclawId,
            dmPolicy: prepared.oldConfig.dmPolicy,
            allowFrom: prepared.oldConfig.allowFrom,
            discordGuilds:
              prepared.connection.channel === 'discord'
                ? prepared.oldConfig.discordGuilds
                : [],
          });
        } catch {
          runtimeRestored = false;
          try {
            await sync.removeHostedChannelAccount({
              channel: prepared.connection.channel,
              runtimeAccountId: prepared.connection.runtime_account_id!,
              deleteAccount: false,
            });
          } catch {
            // Desired-state revocation below keeps secret retrieval closed.
          }
        }
        const compensated = await pg.begin(async (tx) => {
          const currentConnections = await tx<{ metadata: unknown }[]>`
            select metadata from channel_connections
            where id = ${prepared.connection.id}
            for update
          `;
          const currentRequests = await tx<
            Array<{ status: string; expires_at: string; metadata: unknown }>
          >`
            select status, expires_at, metadata
            from channel_pairing_requests
            where id = ${requestId}
            for update
          `;
          const currentConnection = currentConnections[0];
          const currentRequest = currentRequests[0];
          if (
            !currentConnection ||
            !currentRequest ||
            currentRequest.status !== 'approved' ||
            metadataRecord(currentRequest.metadata)._decisionNonce !== marker.nonce ||
            !samePairingDecisionMarker(currentConnection.metadata, marker)
          ) {
            return false;
          }
          await tx`
            update channel_pairing_requests
            set status = case when expires_at > now() then 'pending' else 'expired' end,
                decided_at = null, decided_by_account_id = null,
                metadata = ${tx.json(JSON.stringify(prepared.oldRequestMetadata))},
                updated_at = now()
            where id = ${requestId}
          `;
          if (body.linkToMyAccount) {
            await tx`
              update channel_external_identities
              set linked_account_id = ${prepared.previousLinkedAccountId}, updated_at = now()
              where id = ${prepared.identityId}
                and linked_account_id = ${account.accountId}
            `;
          }
          await tx`
            update channel_connections
            set metadata = ${tx.json(JSON.stringify(prepared.oldConnectionMetadata))}, updated_at = now()
            where id = ${prepared.connection.id}
          `;
          return true;
        });
        if (!runtimeRestored || !compensated) {
          await pg`
            update channel_connections
            set desired_state = 'inactive', observed_state = 'error', status = 'error',
                last_error_code = 'configuration_error',
                last_error_message = ${SAFE_RUNTIME_ERRORS.configuration_error!},
                updated_at = now()
            where id = ${prepared.connection.id}
          `;
        }
        app.log.warn({ err: error, requestId }, 'channel pairing runtime apply failed');
        throw new ApiError(502, 'configuration_error', SAFE_RUNTIME_ERRORS.configuration_error!);
      }

      // Remove the one-time code and internal compensation markers only after
      // the gateway config has durably accepted the claimed allowlist.
      let cleanupSucceeded = false;
      try {
        cleanupSucceeded = await pg.begin(async (tx) => {
          const current = await tx<{ metadata: unknown }[]>`
            select metadata from channel_connections
            where id = ${prepared.connection.id}
            for update
          `;
          if (!current[0] || !samePairingDecisionMarker(current[0].metadata, marker)) {
            return false;
          }
          const request = await tx<{ status: string; metadata: unknown }[]>`
            select status, metadata from channel_pairing_requests
            where id = ${requestId}
            for update
          `;
          if (
            request[0]?.status !== 'approved' ||
            metadataRecord(request[0].metadata)._decisionNonce !== marker.nonce
          ) {
            return false;
          }
          const cleanConnectionMetadata = { ...metadataRecord(current[0].metadata) };
          delete cleanConnectionMetadata._pairingDecision;
          const cleanRequestMetadata: Record<string, unknown> = {
            ...prepared.newRequestMetadata,
          };
          delete cleanRequestMetadata._decisionNonce;
          delete cleanRequestMetadata.pairingCode;
          await tx`
            update channel_connections
            set metadata = ${tx.json(JSON.stringify(cleanConnectionMetadata))}, updated_at = now()
            where id = ${prepared.connection.id}
          `;
          await tx`
            update channel_pairing_requests
            set metadata = ${tx.json(JSON.stringify(cleanRequestMetadata))}, updated_at = now()
            where id = ${requestId} and status = 'approved'
          `;
          return true;
        });
      } catch (error) {
        app.log.error({ err: error, requestId }, 'channel pairing marker cleanup failed');
      }
      if (!cleanupSucceeded) {
        try {
          await sync.removeHostedChannelAccount({
            channel: prepared.connection.channel,
            runtimeAccountId: prepared.connection.runtime_account_id!,
            deleteAccount: false,
          });
        } catch {
          // Revoking desired state still cuts off the SecretRef.
        }
        await pg`
          update channel_connections
          set desired_state = 'inactive', observed_state = 'error', status = 'error',
              last_error_code = 'configuration_error',
              last_error_message = ${SAFE_RUNTIME_ERRORS.configuration_error!},
              updated_at = now()
          where id = ${prepared.connection.id}
        `;
        throw new ApiError(502, 'configuration_error', SAFE_RUNTIME_ERRORS.configuration_error!);
      }
      return { ok: true, linkedToMyAccount: body.linkToMyAccount };
    },
  );

  app.post(
    '/connections/:id/pairing/:requestId/deny',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const account = req.account!;
      const { id, requestId } = pairingParamsSchema.parse(req.params);
      const connection = await getOwnedConnection(id, account.accountId, account.isAdmin);
      if (!connection) {
        return sendError(reply, 404, 'channel_connection_not_found', 'Connection not found');
      }
      const rows = await pg<{ id: string }[]>`
        update channel_pairing_requests
        set status = 'denied', decided_at = now(), decided_by_account_id = ${account.accountId},
            updated_at = now()
        where id = ${requestId} and connection_id = ${connection.id}
          and status = 'pending' and expires_at > now()
        returning id
      `;
      if (!rows[0]) return sendError(reply, 409, 'pairing_request_not_pending', 'Request is not pending');
      return { ok: true };
    },
  );

  // Private runtime callbacks. They accept only the existing gateway bearer;
  // no browser cookie and no database credential is available to OpenClaw.
  app.post('/runtime/messages', { preHandler: requireRuntime }, async (req) => {
    const body = runtimeMessageSchema.parse(req.body);
    const result = await sessionSync.syncMessage({
      ...body,
      createdAt: new Date(body.createdAt),
    });
    return { ok: true, ...result };
  });

  app.post('/runtime/pairing', { preHandler: requireRuntime }, async (req) => {
    const body = runtimePairingSchema.parse(req.body);
    const connectionRows = await pg<
      Array<{ id: string; account_id: string; channel: string; runtime_account_id: string }>
    >`
      select id, account_id, channel, runtime_account_id
      from channel_connections
      where id = ${body.connectionId} and runtime_account_id = ${body.runtimeAccountId}
        and desired_state = 'active' and channel in ('discord', 'telegram')
      limit 1
    `;
    const connection = connectionRows[0];
    if (!connection) throw new ApiError(404, 'channel_connection_unavailable', 'Connection unavailable');
    const fingerprint = channelPeerFingerprint(connection.id, body.peerId);
    const encrypted = vault.encrypt(
      body.peerId,
      channelPeerSecretContext(connection.id, fingerprint),
    );
    const encryptedCode = vault.encrypt(
      body.code,
      channelPairingCodeSecretContext(connection.id, fingerprint),
    );
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    const requestId = await pg.begin(async (tx) => {
      await tx`
        select pg_advisory_xact_lock(
          hashtextextended(${'channel-pairing:' + connection.id}, 0)
        )
      `;
      await tx`
        update channel_pairing_requests
        set status = 'expired', updated_at = now()
        where connection_id = ${connection.id}
          and status = 'pending' and expires_at <= now()
      `;
      const identities = await tx<{ id: string }[]>`
        insert into channel_external_identities (
          connection_id, peer_fingerprint, peer_ciphertext, peer_iv,
          peer_auth_tag, peer_preview, key_version
        ) values (
          ${connection.id}, ${fingerprint}, ${encrypted.tokenCiphertext},
          ${encrypted.tokenIv}, ${encrypted.tokenAuthTag}, ${encrypted.tokenPreview},
          ${encrypted.keyVersion}
        )
        on conflict (connection_id, peer_fingerprint) do update set updated_at = now()
        returning id
      `;
      const pending = await tx<{ count: number }[]>`
        select count(*)::int as count
        from channel_pairing_requests
        where connection_id = ${connection.id}
          and status = 'pending' and expires_at > now()
          and identity_id <> ${identities[0]!.id}
      `;
      if ((pending[0]?.count ?? 0) >= 3) {
        throw new ApiError(
          429,
          'pairing_request_limit_reached',
          'Too many pending pairing requests',
        );
      }
      const requestMetadata = {
        channel: connection.channel,
        pairingCode: {
          ciphertext: encryptedCode.tokenCiphertext,
          iv: encryptedCode.tokenIv,
          authTag: encryptedCode.tokenAuthTag,
          keyVersion: encryptedCode.keyVersion,
        },
      };
      const requests = await tx<{ id: string }[]>`
        insert into channel_pairing_requests (
          connection_id, identity_id, status, requested_at, expires_at, metadata
        ) values (
          ${connection.id}, ${identities[0]!.id}, 'pending', now(),
          ${expiresAt.toISOString()}::timestamptz,
          ${tx.json(JSON.stringify(requestMetadata))}
        )
        on conflict (connection_id, identity_id) where status = 'pending'
        do update set requested_at = now(), expires_at = excluded.expires_at,
                      metadata = excluded.metadata, updated_at = now()
        returning id
      `;
      return requests[0]!.id;
    });
    return { ok: true, requestId, expiresAt: expiresAt.toISOString() };
  });

  app.post('/runtime/status', { preHandler: requireRuntime }, async (req) => {
    const body = runtimeStatusSchema.parse(req.body);
    const errorCode = body.state === 'error' ? (body.errorCode ?? 'gateway_disconnected') : null;
    const errorMessage = errorCode ? (SAFE_RUNTIME_ERRORS[errorCode] ?? 'Channel runtime error') : null;
    const fatalCredentialError =
      errorCode === 'invalid_token' || errorCode === 'configuration_error';
    if (fatalCredentialError) {
      const connections = await pg<
        Array<{ channel: SupportedChannelProvider; runtime_account_id: string }>
      >`
        select channel, runtime_account_id
        from channel_connections
        where id = ${body.connectionId} and runtime_account_id = ${body.runtimeAccountId}
          and desired_state = 'active' and channel in ('discord', 'telegram')
        limit 1
      `;
      const connection = connections[0];
      if (!connection) {
        throw new ApiError(404, 'channel_connection_unavailable', 'Connection unavailable');
      }
      try {
        await sync.removeHostedChannelAccount({
          channel: connection.channel,
          runtimeAccountId: connection.runtime_account_id,
          deleteAccount: false,
        });
      } catch {
        // The desired-state revocation below still cuts off secret resolution.
      }
    }
    const rows = await pg<{ id: string }[]>`
      update channel_connections
      set desired_state = case
            when ${fatalCredentialError} then 'inactive'
            else desired_state
          end,
          observed_state = ${body.state},
          status = case
            when ${body.state} = 'live' then 'connected'
            when ${body.state} = 'stopped' and desired_state = 'active' then 'reconnecting'
            when ${body.state} = 'stopped' and last_error_code is not null then 'error'
            when ${body.state} = 'stopped' then 'paused'
            else 'error'
          end,
          last_error_code = case
            when ${body.state} = 'stopped'
              and desired_state = 'inactive'
              and last_error_code is not null
              then last_error_code
            else ${errorCode}
          end,
          last_error_message = case
            when ${body.state} = 'stopped'
              and desired_state = 'inactive'
              and last_error_code is not null
              then last_error_message
            else ${errorMessage}
          end,
          updated_at = now()
      where id = ${body.connectionId} and runtime_account_id = ${body.runtimeAccountId}
        and (desired_state = 'active' or ${body.state} = 'stopped')
      returning id
    `;
    if (!rows[0]) throw new ApiError(404, 'channel_connection_unavailable', 'Connection unavailable');
    return { ok: true };
  });

  app.post('/runtime/turns/reserve', { preHandler: requireRuntime }, async (req) => {
    const body = reserveTurnSchema.parse(req.body);
    try {
      const result = await turnMetering.reserve(body);
      return {
        ok: true,
        turnId: result.turn.turnId,
        reservedManna: result.turn.reservedManna,
        balance: result.balance,
        replayed: result.replayed,
        model: result.turn.model,
        agentRuntime: result.turn.agentRuntime,
        pricingBasis: result.turn.pricingBasis,
      };
    } catch (error) {
      if (error instanceof InsufficientMannaError) {
        throw new ApiError(402, 'insufficient_manna', 'Insufficient manna for channel turn');
      }
      if (error instanceof DailyCapExceededError) {
        throw new ApiError(429, 'daily_manna_cap_exceeded', 'Daily manna cap reached');
      }
      if (error instanceof TurnCeilingError) {
        throw new ApiError(
          422,
          'unsupported_channel_model',
          'This agent model is not configured for channel turns',
        );
      }
      throw error;
    }
  });

  app.post('/runtime/turns/:turnId/settle', { preHandler: requireRuntime }, async (req) => {
    const { turnId } = turnParamsSchema.parse(req.params);
    const { usage, provider, model, agentRuntime } = settleTurnSchema.parse(req.body ?? {});
    try {
      const result = await turnMetering.settle(
        turnId,
        usage as ChannelTurnUsage | undefined,
        { provider, model, agentRuntime },
      );
      return { ok: true, turnId, chargedManna: result.chargedManna, metering: result.metering };
    } catch (error) {
      if (error instanceof ChannelExecutionMismatchError) {
        throw new ApiError(
          409,
          'channel_execution_mismatch',
          'Provider execution did not match the reserved channel model',
        );
      }
      if (error instanceof InsufficientMannaError) {
        throw new ApiError(402, 'insufficient_manna', 'Insufficient manna for settlement');
      }
      if (error instanceof DailyCapExceededError) {
        throw new ApiError(429, 'daily_manna_cap_exceeded', 'Daily manna cap reached');
      }
      throw error;
    }
  });

  app.post('/runtime/turns/:turnId/refund', { preHandler: requireRuntime }, async (req) => {
    const { turnId } = turnParamsSchema.parse(req.params);
    await turnMetering.refund(turnId);
    return { ok: true, turnId };
  });

  app.post('/runtime/turns/:turnId/delivery-failed', { preHandler: requireRuntime }, async (req) => {
    const { turnId } = turnParamsSchema.parse(req.params);
    await turnMetering.refundDeliveryFailure(turnId);
    return { ok: true, turnId };
  });

  app.post('/runtime/turns/:turnId/delivered', { preHandler: requireRuntime }, async (req) => {
    const { turnId } = turnParamsSchema.parse(req.params);
    await turnMetering.markDelivered(turnId);
    return { ok: true, turnId };
  });

  if (turnMetering.refundStale) {
    const reap = async () => {
      try {
        const claimed = await turnMetering.refundStale!();
        if (claimed > 0) app.log.warn({ claimed }, 'refunded stale channel turns');
      } catch (error) {
        app.log.error({ err: error }, 'channel turn stale-refund sweep failed');
      }
    };
    const reaper = setInterval(() => void reap(), 5 * 60_000);
    reaper.unref();
    app.addHook('onClose', async () => clearInterval(reaper));
  }
};
