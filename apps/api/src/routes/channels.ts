import { getEnv, resolveAgentByUsername } from '@eden3/core';
import { channelConnections, db, pg, secretAccessAuditEvents } from '@eden3/db';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ApiError, sendError } from '../errors';
import { FixedWindowRateLimiter } from '../services/http-hardening';
import { defaultSecretVault, type SecretVaultLike } from '../services/secret-vault';

export interface ChannelsRoutesOptions {
  vault?: SecretVaultLike;
}

const channelSchema = z.enum(['discord', 'telegram', 'whatsapp', 'slack', 'voice']);

const createConnectionBodySchema = z.object({
  channel: channelSchema,
  token: z.string().trim().min(1).max(20_000),
  label: z.string().trim().max(120).optional(),
  agentUsername: z.string().trim().min(1).max(200).optional(),
});

const paramsSchema = z.object({ id: z.string().uuid() });

const mockMessageBodySchema = z.object({
  message: z.string().trim().min(1).max(4_000),
});

const CHANNEL_REPLY_LIMIT = { windowMs: 60_000, max: 3 };
const channelReplyLimiter = new FixedWindowRateLimiter(CHANNEL_REPLY_LIMIT);

const BLOCKED_MESSAGE_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: 'secret_exfiltration', pattern: /\b(api[_ -]?key|bearer token|private key|password|secret|token)\b/i },
  { code: 'prompt_injection', pattern: /\b(ignore (all )?(previous|prior) instructions|system prompt|developer message)\b/i },
  { code: 'cross_user_data', pattern: /\b(other users?|another users?|all users?|database dump|export user data)\b/i },
];

interface ChannelConnectionRow {
  id: string;
  account_id: string;
  agent_id: string | null;
  channel: string;
  label: string | null;
  status: string;
  token_ciphertext: string;
  token_iv: string;
  token_auth_tag: string;
  token_sha256: string;
  token_preview: string | null;
  key_version: string;
  created_at: string;
  updated_at: string;
}

function dto(row: ChannelConnectionRow) {
  return {
    id: row.id,
    accountId: row.account_id,
    agentId: row.agent_id,
    channel: row.channel,
    label: row.label,
    status: row.status,
    tokenPreview: row.token_preview,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function rejectUnsafeChannelMessage(message: string): { code: string; reason: string } | null {
  for (const blocked of BLOCKED_MESSAGE_PATTERNS) {
    if (blocked.pattern.test(message)) {
      return {
        code: blocked.code,
        reason: 'Message rejected by channel safety filter',
      };
    }
  }
  return null;
}

async function audit(params: {
  actorAccountId: string;
  ownerAccountId: string;
  secretId: string;
  action: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(secretAccessAuditEvents).values({
    actorAccountId: params.actorAccountId,
    ownerAccountId: params.ownerAccountId,
    secretKind: 'channel_token',
    secretId: params.secretId,
    action: params.action,
    metadata: params.metadata ?? null,
  });
}

async function getOwnedConnection(id: string, accountId: string, isAdmin: boolean): Promise<ChannelConnectionRow | null> {
  const rows = await pg<ChannelConnectionRow[]>`
    select id, account_id, agent_id, channel, label, status,
           token_ciphertext, token_iv, token_auth_tag, token_sha256,
           token_preview, key_version, created_at, updated_at
    from channel_connections
    where id = ${id}
      ${isAdmin ? pg`` : pg`and account_id = ${accountId}`}
    limit 1
  `;
  return rows[0] ?? null;
}

async function channelQuotaError(account: { accountId: string; isAdmin: boolean }): Promise<{
  statusCode: 429;
  code: 'channel_quota_exceeded';
  message: string;
} | null> {
  if (account.isAdmin) return null;
  const limit = getEnv().MAX_CHANNEL_CONNECTIONS_PER_USER;
  const [quota] = await pg<{ count: number }[]>`
    select count(*)::int as count
    from channel_connections
    where account_id = ${account.accountId}
  `;
  if ((quota?.count ?? 0) >= limit) {
    return {
      statusCode: 429,
      code: 'channel_quota_exceeded',
      message: `Channel connection limit reached (${limit} connections)`,
    };
  }
  return null;
}

export const channelsRoutes: FastifyPluginAsync<ChannelsRoutesOptions> = async (app, opts) => {
  const vault = opts.vault ?? {
    encrypt(plaintext: string) {
      try {
        return defaultSecretVault().encrypt(plaintext);
      } catch (err) {
        throw new ApiError(
          503,
          'secret_vault_not_configured',
          err instanceof Error ? err.message : 'Secret vault is not configured',
        );
      }
    },
    decrypt(record) {
      try {
        return defaultSecretVault().decrypt(record);
      } catch (err) {
        throw new ApiError(
          503,
          'secret_vault_not_configured',
          err instanceof Error ? err.message : 'Secret vault is not configured',
        );
      }
    },
  } satisfies SecretVaultLike;

  app.get('/connections', { preHandler: app.requireAuth }, async (req) => {
    const account = req.account!;
    const rows = await pg<ChannelConnectionRow[]>`
      select id, account_id, agent_id, channel, label, status,
             token_ciphertext, token_iv, token_auth_tag, token_sha256,
             token_preview, key_version, created_at, updated_at
      from channel_connections
      where ${account.isAdmin ? pg`true` : pg`account_id = ${account.accountId}`}
      order by updated_at desc, id desc
    `;
    return { items: rows.map(dto) };
  });

  app.post('/connections', { preHandler: app.requireAuth }, async (req, reply) => {
    const account = req.account!;
    const body = createConnectionBodySchema.parse(req.body);
    let agentId: string | null = null;
    if (body.agentUsername) {
      const resolved = await resolveAgentByUsername(body.agentUsername);
      if (!resolved) {
        return sendError(reply, 404, 'agent_not_found', `No agent named "${body.agentUsername}"`);
      }
      if (!account.isAdmin && resolved.agent.ownerId !== account.accountId) {
        return sendError(reply, 403, 'forbidden', 'Only the owner can attach channels to this agent');
      }
      agentId = resolved.account.id;
    }

    const quotaError = await channelQuotaError(account);
    if (quotaError) {
      return sendError(reply, quotaError.statusCode, quotaError.code, quotaError.message);
    }

    const encrypted = vault.encrypt(body.token);
    const [row] = await pg<ChannelConnectionRow[]>`
      insert into channel_connections (
        account_id, agent_id, channel, label, status,
        token_ciphertext, token_iv, token_auth_tag, token_sha256, token_preview,
        key_version
      )
      values (
        ${account.accountId}, ${agentId}, ${body.channel}, ${body.label ?? null}, 'connected',
        ${encrypted.tokenCiphertext}, ${encrypted.tokenIv}, ${encrypted.tokenAuthTag},
        ${encrypted.tokenSha256}, ${encrypted.tokenPreview}, ${encrypted.keyVersion}
      )
      returning id, account_id, agent_id, channel, label, status,
                token_ciphertext, token_iv, token_auth_tag, token_sha256,
                token_preview, key_version, created_at, updated_at
    `;
    await audit({
      actorAccountId: account.accountId,
      ownerAccountId: account.accountId,
      secretId: row!.id,
      action: 'store',
      metadata: { channel: body.channel, agentId },
    });
    return reply.code(201).send({ connection: dto(row!) });
  });

  app.post('/connections/:id/mock-message', { preHandler: app.requireAuth }, async (req, reply) => {
    const account = req.account!;
    const { id } = paramsSchema.parse(req.params);
    const body = mockMessageBodySchema.parse(req.body);
    const row = await getOwnedConnection(id, account.accountId, account.isAdmin);
    if (!row) return sendError(reply, 404, 'channel_connection_not_found', `No channel connection "${id}"`);

    const blocked = rejectUnsafeChannelMessage(body.message);
    if (blocked) {
      await audit({
        actorAccountId: account.accountId,
        ownerAccountId: row.account_id,
        secretId: row.id,
        action: 'reject',
        metadata: { channel: row.channel, mock: true, code: blocked.code },
      });
      throw new ApiError(400, 'channel_message_rejected', blocked.reason);
    }

    const rate = channelReplyLimiter.hit(`channel:${row.id}`);
    reply.header('x-channel-ratelimit-limit', String(rate.limit));
    reply.header('x-channel-ratelimit-remaining', String(rate.remaining));
    reply.header('x-channel-ratelimit-reset', String(Math.ceil(rate.resetAt / 1000)));
    if (!rate.allowed) {
      reply.header('retry-after', String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))));
      await audit({
        actorAccountId: account.accountId,
        ownerAccountId: row.account_id,
        secretId: row.id,
        action: 'rate_limited',
        metadata: { channel: row.channel, mock: true },
      });
      throw new ApiError(
        429,
        'channel_reply_rate_limited',
        `Too many channel replies; retry after ${Math.max(1, Math.ceil(rate.retryAfterMs / 1000))}s`,
      );
    }

    // Decrypt only inside the routing path. The plaintext is never returned.
    const token = vault.decrypt({
      tokenCiphertext: row.token_ciphertext,
      tokenIv: row.token_iv,
      tokenAuthTag: row.token_auth_tag,
      keyVersion: row.key_version,
    });
    await audit({
      actorAccountId: account.accountId,
      ownerAccountId: row.account_id,
      secretId: row.id,
      action: 'retrieve',
      metadata: { channel: row.channel, mock: true, tokenLength: token.length },
    });
    return { ok: true, channel: row.channel, routed: true, messageLength: body.message.length };
  });

  app.delete('/connections/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const account = req.account!;
    const { id } = paramsSchema.parse(req.params);
    const row = await getOwnedConnection(id, account.accountId, account.isAdmin);
    if (!row) return sendError(reply, 404, 'channel_connection_not_found', `No channel connection "${id}"`);
    await db.delete(channelConnections).where(eq(channelConnections.id, id));
    await audit({
      actorAccountId: account.accountId,
      ownerAccountId: row.account_id,
      secretId: row.id,
      action: 'delete',
      metadata: { channel: row.channel },
    });
    return { ok: true };
  });
};
