import { parseSecretId } from '@eden3/gateway';

import { ChannelConnectionQuotaExceededError } from './channel-connection-quota';

const TELEGRAM_USERNAME = /^[A-Za-z0-9_]{5,32}$/;
const TELEGRAM_BOT_TOKEN = /^\d{5,20}:[A-Za-z0-9_-]{20,200}$/;
const TELEGRAM_USER_ID = /^\d{1,20}$/;
const RUNTIME_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type TelegramManagedBotErrorCode =
  | 'manager_bot_username_invalid'
  | 'managed_bot_username_invalid'
  | 'managed_bot_name_invalid'
  | 'managed_bot_update_invalid'
  | 'managed_bot_id_invalid'
  | 'managed_bot_owner_mismatch'
  | 'manager_bot_credentials_invalid'
  | 'managed_bot_not_found'
  | 'telegram_rate_limited'
  | 'telegram_unavailable'
  | 'telegram_response_invalid'
  | 'channel_quota_exceeded'
  | 'channel_custody_unavailable'
  | 'channel_secret_scope_invalid'
  | 'managed_bot_connection_not_found'
  | 'managed_bot_state_unavailable'
  | 'managed_bot_activation_failed'
  | 'managed_bot_revocation_failed'
  | 'managed_bot_state_conflict';

/** A user-safe setup error. Never place provider bodies, URLs, or tokens in it. */
export class TelegramManagedBotError extends Error {
  constructor(
    readonly code: TelegramManagedBotErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TelegramManagedBotError';
  }
}

function fail(
  code: TelegramManagedBotErrorCode,
  message: string,
  retryable = false,
): never {
  throw new TelegramManagedBotError(code, message, retryable);
}

function withoutAt(value: string): string {
  return value.startsWith('@') ? value.slice(1) : value;
}

function botUsername(
  raw: string,
  code: 'manager_bot_username_invalid' | 'managed_bot_username_invalid',
  appendSuffix: boolean,
): string {
  const stripped = withoutAt(raw.trim());
  const normalized = appendSuffix && !/bot$/i.test(stripped) ? `${stripped}bot` : stripped;
  if (!TELEGRAM_USERNAME.test(normalized) || !/bot$/i.test(normalized)) {
    fail(
      code,
      code === 'manager_bot_username_invalid'
        ? 'Enter the configured Telegram manager bot username.'
        : 'Use a Telegram bot username containing 5–32 letters, numbers, or underscores.',
    );
  }
  return normalized;
}

/**
 * Build Telegram's managed-bot creation request link. Telegram clients own the
 * actual account-creation UI; Eden never impersonates a user or calls MTProto.
 */
export function createTelegramManagedBotDeepLink(input: {
  managerBotUsername: string;
  suggestedBotUsername?: string;
  suggestedBotName?: string;
}): string {
  const manager = botUsername(input.managerBotUsername, 'manager_bot_username_invalid', false);
  const suggestedUsername = input.suggestedBotUsername
    ? botUsername(input.suggestedBotUsername, 'managed_bot_username_invalid', true)
    : null;
  let suggestedName: string | null = null;
  if (input.suggestedBotName !== undefined) {
    suggestedName = input.suggestedBotName.trim();
    if (suggestedName.length < 1 || suggestedName.length > 64) {
      fail('managed_bot_name_invalid', 'Use a Telegram bot name between 1 and 64 characters.');
    }
  }

  const url = new URL(
    `https://t.me/newbot/${encodeURIComponent(manager)}${
      suggestedUsername ? `/${encodeURIComponent(suggestedUsername)}` : ''
    }`,
  );
  if (suggestedName) url.searchParams.set('name', suggestedName);
  return url.toString();
}

export interface TelegramManagedBotApiClientLike {
  /** Returned plaintext must be handed immediately to TelegramManagedBotCustodyLike. */
  getManagedBotToken(managedBotUserId: string): Promise<string>;
}

type FetchLike = typeof fetch;

interface BotApiEnvelope {
  ok?: unknown;
  result?: unknown;
  error_code?: unknown;
  parameters?: { retry_after?: unknown };
}

function safeUserId(value: string): string {
  if (!TELEGRAM_USER_ID.test(value) || value === '0') {
    fail('managed_bot_id_invalid', 'Telegram did not provide a valid managed bot identifier.');
  }
  return value;
}

function botApiFailure(status: number, body: BotApiEnvelope | null): never {
  const errorCode = typeof body?.error_code === 'number' ? body.error_code : status;
  if (status === 401 || status === 403 || errorCode === 401 || errorCode === 403) {
    fail(
      'manager_bot_credentials_invalid',
      'The Eden manager bot credentials are invalid. Ask an operator to reconnect it.',
    );
  }
  if (status === 429 || errorCode === 429) {
    fail('telegram_rate_limited', 'Telegram is rate-limiting bot setup. Retry shortly.', true);
  }
  if (
    status === 400 ||
    status === 404 ||
    errorCode === 400 ||
    errorCode === 404
  ) {
    fail(
      'managed_bot_not_found',
      'Telegram could not find a bot managed by Eden. Reopen the creation link and finish setup.',
    );
  }
  fail('telegram_unavailable', 'Telegram bot setup is temporarily unavailable.', true);
}

/** Deterministic HTTP client for Bot API getManagedBotToken. */
export class FetchTelegramManagedBotApiClient implements TelegramManagedBotApiClientLike {
  private readonly managerBotToken: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: {
    managerBotToken: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  }) {
    if (!TELEGRAM_BOT_TOKEN.test(opts.managerBotToken)) {
      fail(
        'manager_bot_credentials_invalid',
        'The Eden manager bot credentials are invalid. Ask an operator to reconnect it.',
      );
    }
    this.managerBotToken = opts.managerBotToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 7_500;
  }

  async getManagedBotToken(managedBotUserId: string): Promise<string> {
    const userId = safeUserId(managedBotUserId);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://api.telegram.org/bot${this.managerBotToken}/getManagedBotToken`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user_id: userId }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      fail('telegram_unavailable', 'Telegram bot setup is temporarily unavailable.', true);
    }

    let body: BotApiEnvelope | null = null;
    try {
      body = (await response.json()) as BotApiEnvelope;
    } catch {
      fail('telegram_response_invalid', 'Telegram returned an invalid setup response. Retry.', true);
    }
    if (!response.ok || body?.ok !== true) botApiFailure(response.status, body);
    if (typeof body.result !== 'string' || !TELEGRAM_BOT_TOKEN.test(body.result)) {
      fail('telegram_response_invalid', 'Telegram returned an invalid setup response. Retry.', true);
    }
    return body.result;
  }
}

export interface TelegramManagedBotIdentity {
  id: string;
  username: string;
  displayName: string;
}

export interface TelegramManagedBotOwner {
  id: string;
  username: string | null;
  displayName: string;
}

export interface TelegramManagedBotMetadata {
  owner: TelegramManagedBotOwner;
  bot: TelegramManagedBotIdentity;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function telegramId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && TELEGRAM_USER_ID.test(value) && value !== '0') return value;
  return null;
}

function displayName(value: Record<string, unknown>): string | null {
  const first = typeof value.first_name === 'string' ? value.first_name.trim() : '';
  const last = typeof value.last_name === 'string' ? value.last_name.trim() : '';
  const name = [first, last].filter(Boolean).join(' ');
  return name.length > 0 && name.length <= 129 ? name : null;
}

/** Validate the `managed_bot` update before any token exchange occurs. */
export function normalizeTelegramManagedBotUpdate(input: unknown): TelegramManagedBotMetadata {
  const update = record(input);
  const owner = record(update?.user);
  const bot = record(update?.bot);
  const ownerId = telegramId(owner?.id);
  const botId = telegramId(bot?.id);
  const ownerName = owner ? displayName(owner) : null;
  const managedBotName = bot ? displayName(bot) : null;
  const username = typeof bot?.username === 'string' ? bot.username.trim() : '';
  const ownerUsername =
    typeof owner?.username === 'string' && TELEGRAM_USERNAME.test(owner.username.trim())
      ? owner.username.trim()
      : null;

  if (
    !owner ||
    !bot ||
    !ownerId ||
    !botId ||
    ownerId === botId ||
    owner.is_bot === true ||
    bot.is_bot !== true ||
    !ownerName ||
    !managedBotName ||
    !TELEGRAM_USERNAME.test(username) ||
    !/bot$/i.test(username)
  ) {
    fail(
      'managed_bot_update_invalid',
      'Telegram sent incomplete managed-bot details. Reopen the creation link and try again.',
    );
  }
  return {
    owner: { id: ownerId, username: ownerUsername, displayName: ownerName },
    bot: { id: botId, username, displayName: managedBotName },
  };
}

export interface ScopedChannelSecretRef {
  source: 'exec';
  provider: 'eden-channel-vault';
  id: string;
}

export interface TelegramManagedBotCustodyInput {
  ownerAccountId: string;
  agentId?: string;
  channel: 'telegram';
  label?: string;
  plaintextToken: string;
  owner: TelegramManagedBotOwner;
  bot: TelegramManagedBotIdentity;
}

export interface TelegramManagedBotCustodyResult {
  connectionId: string;
  runtimeAccountId: string;
  secretRef: ScopedChannelSecretRef;
  state: 'stored_inactive';
}

/**
 * Sole permitted plaintext handoff. Its implementation must encrypt into
 * channel_connections and mint hostedChannelSecretRef(scope, capKey) in the
 * same ownership scope. It must not log, return, or persist a plaintext token.
 */
export interface TelegramManagedBotCustodyLike {
  storeManagedBotToken(input: TelegramManagedBotCustodyInput): Promise<TelegramManagedBotCustodyResult>;
}

export type TelegramManagedBotState =
  | 'pending_exchange'
  | 'stored_inactive'
  | 'activating'
  | 'active'
  | 'revoking'
  | 'revoked'
  | 'error';

const TRANSITIONS: Readonly<Record<TelegramManagedBotState, ReadonlySet<TelegramManagedBotState>>> = {
  pending_exchange: new Set(['stored_inactive', 'error']),
  stored_inactive: new Set(['activating', 'revoking', 'error']),
  activating: new Set(['active', 'stored_inactive', 'revoking', 'error']),
  active: new Set(['revoking', 'error']),
  revoking: new Set(['revoked', 'error']),
  revoked: new Set(),
  error: new Set(['pending_exchange', 'activating', 'revoking']),
};

/**
 * Validate durable lifecycle transitions. In particular, activation cannot
 * skip `activating`, and revocation must enter `revoking` before cleanup so the
 * store adapter can cut resolver eligibility first.
 */
export function assertTelegramManagedBotTransition<To extends TelegramManagedBotState>(
  from: TelegramManagedBotState,
  to: To,
): To {
  if (!TRANSITIONS[from].has(to)) {
    fail(
      'managed_bot_state_conflict',
      `Managed bot state changed (${from}); refresh the connection and retry.`,
    );
  }
  return to;
}

export interface TelegramManagedBotOnboardingResult {
  connectionId: string;
  state: 'stored_inactive';
  owner: TelegramManagedBotOwner;
  bot: TelegramManagedBotIdentity;
}

export class TelegramManagedBotsService {
  constructor(
    private readonly botApi: TelegramManagedBotApiClientLike,
    private readonly custody: TelegramManagedBotCustodyLike,
  ) {}

  /** Exchange once, then hand plaintext directly to encrypted scoped custody. */
  async exchangeAndStore(input: {
    ownerAccountId: string;
    /** Server-derived from an existing Telegram pairing; never trust request body. */
    expectedTelegramOwnerId: string;
    agentId?: string;
    label?: string;
    update: unknown;
  }): Promise<TelegramManagedBotOnboardingResult> {
    const metadata = normalizeTelegramManagedBotUpdate(input.update);
    const expectedOwnerId = safeUserId(input.expectedTelegramOwnerId);
    if (metadata.owner.id !== expectedOwnerId) {
      fail(
        'managed_bot_owner_mismatch',
        'This bot was created by a different Telegram account. Pair the owning account first.',
      );
    }
    const token = await this.botApi.getManagedBotToken(metadata.bot.id);
    let custodial: TelegramManagedBotCustodyResult;
    try {
      custodial = await this.custody.storeManagedBotToken({
        ownerAccountId: input.ownerAccountId,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        channel: 'telegram',
        ...(input.label ? { label: input.label } : {}),
        plaintextToken: token,
        owner: metadata.owner,
        bot: metadata.bot,
      });
    } catch (error) {
      if (error instanceof ChannelConnectionQuotaExceededError) {
        fail('channel_quota_exceeded', error.message);
      }
      fail(
        'channel_custody_unavailable',
        'Eden could not secure this bot token. Retry; the bot is not connected yet.',
        true,
      );
    }

    const parsed = parseSecretId(custodial.secretRef.id);
    if (
      custodial.secretRef.source !== 'exec' ||
      custodial.secretRef.provider !== 'eden-channel-vault' ||
      parsed.kind !== 'capability' ||
      parsed.connectionId.toLowerCase() !== custodial.connectionId.toLowerCase() ||
      custodial.state !== 'stored_inactive' ||
      !RUNTIME_ACCOUNT_ID.test(custodial.runtimeAccountId)
    ) {
      fail(
        'channel_secret_scope_invalid',
        'Eden refused an unscoped channel secret. Ask an operator to check token custody.',
      );
    }

    // SecretRef ids are durable bearer capabilities under the D-005 residual.
    // Validate internally, then deliberately keep both the ref and runtime id
    // out of route/service results.
    return {
      connectionId: custodial.connectionId,
      state: custodial.state,
      ...metadata,
    };
  }
}

export interface TelegramManagedBotLifecycleStoreLike {
  /** Must enforce account ownership and return null for cross-account ids. */
  getOwnedState(
    ownerAccountId: string,
    connectionId: string,
  ): Promise<TelegramManagedBotState | null>;
  /**
   * Durable compare-and-set. Entering `revoking` MUST set desired_state to
   * inactive in the same commit, cutting resolver eligibility before return.
   */
  compareAndSet(input: {
    ownerAccountId: string;
    connectionId: string;
    from: TelegramManagedBotState;
    to: TelegramManagedBotState;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<boolean>;
}

export interface TelegramManagedBotRuntimeLike {
  activate(input: { ownerAccountId: string; connectionId: string }): Promise<void>;
  deactivate(input: { ownerAccountId: string; connectionId: string }): Promise<void>;
}

export interface TelegramManagedBotLifecycleResult {
  state: 'active' | 'revoked';
  changed: boolean;
  warning?: 'runtime_cleanup_pending';
}

function stateConflict(): never {
  fail(
    'managed_bot_state_conflict',
    'Managed bot state changed; refresh the connection and retry.',
    true,
  );
}

/**
 * Coordinates crash-safe activation/revocation around injected durable and
 * runtime adapters. It owns no token and never retrieves one from custody.
 */
export class TelegramManagedBotLifecycle {
  constructor(
    private readonly store: TelegramManagedBotLifecycleStoreLike,
    private readonly runtime: TelegramManagedBotRuntimeLike,
  ) {}

  private async ownedState(input: {
    ownerAccountId: string;
    connectionId: string;
  }): Promise<TelegramManagedBotState> {
    let state: TelegramManagedBotState | null;
    try {
      state = await this.store.getOwnedState(input.ownerAccountId, input.connectionId);
    } catch {
      fail(
        'managed_bot_state_unavailable',
        'Eden could not load this Telegram connection. Retry.',
        true,
      );
    }
    if (!state) {
      fail(
        'managed_bot_connection_not_found',
        'This Telegram managed-bot connection was not found.',
      );
    }
    return state;
  }

  async activate(input: {
    ownerAccountId: string;
    connectionId: string;
  }): Promise<TelegramManagedBotLifecycleResult> {
    const state = await this.ownedState(input);
    if (state === 'active') return { state: 'active', changed: false };
    assertTelegramManagedBotTransition(state, 'activating');
    try {
      if (
        !(await this.store.compareAndSet({
          ...input,
          from: state,
          to: 'activating',
        }))
      ) {
        stateConflict();
      }
    } catch (error) {
      if (error instanceof TelegramManagedBotError) throw error;
      fail(
        'managed_bot_activation_failed',
        'Eden could not begin Telegram bot activation. Retry.',
        true,
      );
    }

    try {
      await this.runtime.activate(input);
    } catch {
      try {
        await this.store.compareAndSet({
          ...input,
          from: 'activating',
          to: 'stored_inactive',
          errorCode: 'managed_bot_activation_failed',
          errorMessage: 'The Telegram runtime could not activate this bot. Retry.',
        });
      } catch {
        // The adapter's activating state remains visible and fail-closed for
        // reconciliation; never surface its raw storage failure.
      }
      fail(
        'managed_bot_activation_failed',
        'The Telegram runtime could not activate this bot. Retry.',
        true,
      );
    }

    let published = false;
    try {
      published = await this.store.compareAndSet({
        ...input,
        from: 'activating',
        to: 'active',
      });
    } catch {
      // Compensate below, then return only a safe actionable error.
    }
    if (!published) {
      // A concurrent revoke may have durably cut resolver eligibility. Ensure
      // late runtime activation cannot reanimate the named account.
      try {
        await this.runtime.deactivate(input);
      } catch {
        // Resolver eligibility is controlled by the durable store, not cleanup.
      }
      fail(
        'managed_bot_activation_failed',
        'Eden could not finish Telegram bot activation. Refresh and retry.',
        true,
      );
    }
    return { state: 'active', changed: true };
  }

  async revoke(input: {
    ownerAccountId: string;
    connectionId: string;
  }): Promise<TelegramManagedBotLifecycleResult> {
    const state = await this.ownedState(input);
    if (state === 'revoked') return { state: 'revoked', changed: false };
    assertTelegramManagedBotTransition(state, 'revoking');

    try {
      if (
        !(await this.store.compareAndSet({
          ...input,
          from: state,
          to: 'revoking',
        }))
      ) {
        stateConflict();
      }
    } catch (error) {
      if (error instanceof TelegramManagedBotError) throw error;
      fail(
        'managed_bot_revocation_failed',
        'Eden could not revoke this connection safely. Retry immediately.',
        true,
      );
    }

    let warning: TelegramManagedBotLifecycleResult['warning'];
    try {
      await this.runtime.deactivate(input);
    } catch {
      // The revoking commit already disabled resolver access. Runtime cleanup
      // is retryable operational work, not a reason to restore the secret.
      warning = 'runtime_cleanup_pending';
    }

    try {
      if (
        !(await this.store.compareAndSet({
          ...input,
          from: 'revoking',
          to: 'revoked',
          ...(warning
            ? {
                errorCode: warning,
                errorMessage: 'Token access is revoked; runtime cleanup will retry.',
              }
            : {}),
        }))
      ) {
        stateConflict();
      }
    } catch (error) {
      if (error instanceof TelegramManagedBotError) throw error;
      fail(
        'managed_bot_revocation_failed',
        'Token access is disabled, but Eden could not finish revocation. Retry.',
        true,
      );
    }
    return { state: 'revoked', changed: true, ...(warning ? { warning } : {}) };
  }
}
