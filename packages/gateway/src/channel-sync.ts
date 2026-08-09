import {
  ConfigGenError,
  EDEN_CHANNEL_RUNTIME_PLUGIN_ID,
  EDEN_CHANNEL_RUNTIME_PLUGIN_PATH,
  mutateOpenClawConfig,
  openClawEnvSecretRef,
  removeHostedChannelRuntimeMapping,
  resolveDataDir,
  upsertHostedChannelRuntimeMapping,
  type ConfigGenOptions,
  type HostedChannelRuntimeGroup,
  type OpenClawConfig,
} from './config-gen';
import {
  deriveCapabilityKey,
  mintCapabilityId,
  type CapabilityScope,
} from './channel-secret-capability';

/**
 * Channel runtime wiring — projects eden3 channel connections into
 * openclaw.json's `channels.*` + `bindings` keys so a connected channel can
 * actually send and receive (the custody rows in Postgres are only the
 * encrypted token record + audit trail).
 *
 * The legacy single-Discord helpers below remain for compatibility. Hosted
 * Discord and Telegram connections use the named-account helpers later in
 * this file: each account stores an exec SecretRef backed by the private Eden
 * resolver socket, never a plaintext token or gateway environment secret.
 *
 * CAUTION (same as config-gen): the gateway validates the config schema
 * strictly — one invalid key rejects the WHOLE file. Only keys source-verified
 * against OpenClaw 2026.7.1 are written here:
 * `channels.discord.{token,enabled,dmPolicy,allowFrom}` and top-level
 * `bindings[]` ({agentId, match:{channel,peer:{kind,id}}}).
 */

export interface DiscordChannelOptions extends ConfigGenOptions {
  /**
   * Env var name (inside the gateway container) holding the bot token.
   * The name becomes a SecretRef id; the value is never read or persisted.
   */
  tokenEnvVar: string;
  /**
   * Discord user ids allowed to DM the bot (`dmPolicy: "allowlist"`). Keeps
   * the surface closed: unknown users are blocked rather than offered
   * pairing, which suits a hosted platform where pairing codes would land in
   * strangers' DMs.
   */
  allowFrom: string[];
  /**
   * Route DMs from `allowFrom[i]` to this OpenClaw agent id via a peer
   * binding (omit to let the gateway's default agent answer).
   */
  bindAgentId?: string;
}

interface BindingEntry {
  agentId: string;
  match: {
    channel: string;
    peer: { kind: string; id: string };
  };
}

function bindingsOf(config: OpenClawConfig): BindingEntry[] {
  const raw = config.bindings;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigGenError('openclaw.json: bindings must be an array');
  }
  return raw as BindingEntry[];
}

function sameDmBinding(a: BindingEntry, channel: string, peerId: string): boolean {
  return (
    a?.match?.channel === channel && a?.match?.peer?.kind === 'dm' && a?.match?.peer?.id === peerId
  );
}

/**
 * Enable the Discord channel with an env-sourced token, allowlist DM policy,
 * and (optionally) per-user DM→agent bindings. Idempotent: writes only when
 * something actually changed; preserves unrelated bindings and channel keys.
 */
export async function ensureDiscordChannel(
  options: DiscordChannelOptions,
): Promise<{ changed: boolean; config: OpenClawConfig }> {
  if (options.allowFrom.length === 0) {
    throw new ConfigGenError('ensureDiscordChannel: allowFrom must name at least one user id');
  }
  const token = openClawEnvSecretRef(options.tokenEnvVar);
  const dataDir = options.dataDir ?? resolveDataDir();
  const mutation = await mutateOpenClawConfig(dataDir, (config) => {
    let changed = false;

    const channels = (config.channels ??= {}) as Record<string, unknown>;
    const discordRaw = (channels.discord ??= {});
    if (typeof discordRaw !== 'object' || discordRaw === null || Array.isArray(discordRaw)) {
      throw new ConfigGenError('openclaw.json: channels.discord must be an object');
    }
    const discord = discordRaw as Record<string, unknown>;

    const desired: Record<string, unknown> = {
      token,
      enabled: true,
      dmPolicy: 'allowlist',
      allowFrom: [...options.allowFrom],
    };
    for (const [key, value] of Object.entries(desired)) {
      if (JSON.stringify(discord[key]) !== JSON.stringify(value)) {
        discord[key] = value;
        changed = true;
      }
    }

    if (options.bindAgentId) {
      const bindings = bindingsOf(config);
      for (const userId of options.allowFrom) {
        const entry: BindingEntry = {
          agentId: options.bindAgentId,
          match: { channel: 'discord', peer: { kind: 'dm', id: userId } },
        };
        const existingIndex = bindings.findIndex((b) => sameDmBinding(b, 'discord', userId));
        if (existingIndex === -1) {
          bindings.push(entry);
          changed = true;
        } else if (JSON.stringify(bindings[existingIndex]) !== JSON.stringify(entry)) {
          bindings[existingIndex] = entry;
          changed = true;
        }
      }
      if (config.bindings === undefined && bindings.length > 0) {
        config.bindings = bindings;
      }
    }

    return changed;
  });
  return { changed: mutation.changed, config: mutation.config };
}

/**
 * Disable the Discord channel (keeps token reference/allowlist for a later
 * re-enable; removes the routing bindings so DMs stop reaching agents).
 */
export async function disableDiscordChannel(
  options: ConfigGenOptions = {},
): Promise<{ changed: boolean; config: OpenClawConfig }> {
  const dataDir = options.dataDir ?? resolveDataDir();
  const mutation = await mutateOpenClawConfig(dataDir, (config) => {
    let changed = false;

    const channels = config.channels as Record<string, unknown> | undefined;
    const discord = channels?.discord as Record<string, unknown> | undefined;
    if (discord && discord.enabled !== false) {
      discord.enabled = false;
      changed = true;
    }
    if (Array.isArray(config.bindings)) {
      const kept = (config.bindings as BindingEntry[]).filter(
        (b) => b?.match?.channel !== 'discord',
      );
      if (kept.length !== config.bindings.length) {
        config.bindings = kept;
        changed = true;
      }
    }

    return changed;
  });
  return { changed: mutation.changed, config: mutation.config };
}

// ---------------------------------------------------------------------------
// Eden hosted connections (WS5): named accounts + private vault SecretRefs
// ---------------------------------------------------------------------------

export type HostedChannelKind = 'discord' | 'telegram';
export type HostedChannelDmPolicy = 'pairing' | 'allowlist';

export const EDEN_CHANNEL_SECRET_PROVIDER_ID = 'eden-channel-vault';
export const EDEN_CHANNEL_SECRET_RESOLVER_COMMAND =
  '/usr/local/bin/eden-channel-secret-resolver';
export const EDEN_CHANNEL_SECRET_RESOLVER_SOCKET =
  '/run/eden3/channel-secrets.sock';

export interface OpenClawExecSecretRef {
  source: 'exec';
  provider: typeof EDEN_CHANNEL_SECRET_PROVIDER_ID;
  id: string;
}

export interface HostedChannelGuildSelection {
  guildId: string;
  channelIds: string[];
}

export interface HostedTelegramGroupSelection {
  groupId: string;
}

export interface HostedChannelAccountOptions extends ConfigGenOptions {
  channel: HostedChannelKind;
  /** Stable OpenClaw account id, normally the attached agent's openclaw id. */
  runtimeAccountId: string;
  /** UUID of channel_connections; the resolver uses only this opaque id. */
  connectionId: string;
  /** channel_connections.account_id (owner) — bound into the capability MAC. */
  accountId: string;
  /** Exact dedicated channel_connections capability generation encoded as cN. */
  capabilityEpoch: string;
  label?: string | null;
  bindAgentId: string;
  /** Opaque generation of this exact published runtime mapping. */
  bindingId?: string;
  dmPolicy: HostedChannelDmPolicy;
  allowFrom: string[];
  discordGuilds?: HostedChannelGuildSelection[];
  telegramGroups?: HostedTelegramGroupSelection[];
}

export interface RemoveHostedChannelAccountOptions extends ConfigGenOptions {
  channel: HostedChannelKind;
  runtimeAccountId: string;
  /** False pauses the account while retaining its SecretRef; true removes it. */
  deleteAccount?: boolean;
}

interface HostedBindingEntry {
  agentId: string;
  match: {
    channel: string;
    accountId?: string;
    peer?: { kind: string; id: string };
  };
  [key: string]: unknown;
}

const CONNECTION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIME_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHANNEL_EXTERNAL_ID = /^-?[0-9]{3,25}$/;

function hostedBindingsOf(config: OpenClawConfig): HostedBindingEntry[] {
  const raw = config.bindings;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigGenError('openclaw.json: bindings must be an array');
  }
  return raw as HostedBindingEntry[];
}

function objectAt(
  parent: Record<string, unknown>,
  key: string,
  pathLabel: string,
): Record<string, unknown> {
  const raw = (parent[key] ??= {});
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigGenError(`openclaw.json: ${pathLabel} must be an object`);
  }
  return raw as Record<string, unknown>;
}

function setHostedValue(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean {
  if (JSON.stringify(target[key]) === JSON.stringify(value)) return false;
  target[key] = value;
  return true;
}

function deleteHostedValue(target: Record<string, unknown>, key: string): boolean {
  if (!(key in target)) return false;
  delete target[key];
  return true;
}

function normalizedAllowFrom(values: string[]): string[] {
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (unique.length > 100) {
    throw new ConfigGenError('hosted channel allowFrom cannot exceed 100 entries');
  }
  for (const value of unique) {
    if (!CHANNEL_EXTERNAL_ID.test(value)) {
      throw new ConfigGenError(`invalid hosted channel sender id ${JSON.stringify(value)}`);
    }
  }
  return unique;
}

function validateHostedAccountIdentity(runtimeAccountId: string, connectionId: string): void {
  if (!RUNTIME_ACCOUNT_ID.test(runtimeAccountId)) {
    throw new ConfigGenError(
      'hosted channel runtimeAccountId must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
    );
  }
  if (!CONNECTION_UUID.test(connectionId)) {
    throw new ConfigGenError('hosted channel connectionId must be a UUID');
  }
}

/**
 * Mint the capability-bound exec SecretRef for a hosted channel account
 * (T12-U01). The id carries an HMAC over the connection's routing scope keyed
 * by a secret derived from CHANNEL_TOKEN_ENCRYPTION_KEY, so the resolver only
 * releases the token to a request bearing this exact capability — a caller in a
 * sandbox/compromised-agent position cannot forge, cross-scope-replay, or
 * enumerate. The caller must project the row's durable capability epoch: a
 * silent default would re-mint a stale c1 reference after credential rotation.
 */
export function hostedChannelSecretRef(
  scope: CapabilityScope,
  capKey: Buffer,
): OpenClawExecSecretRef {
  if (!CONNECTION_UUID.test(scope.connectionId)) {
    throw new ConfigGenError('hosted channel SecretRef connection id must be a UUID');
  }
  return {
    source: 'exec',
    provider: EDEN_CHANNEL_SECRET_PROVIDER_ID,
    id: mintCapabilityId(capKey, {
      connectionId: scope.connectionId,
      accountId: scope.accountId,
      channel: scope.channel,
      runtimeAccountId: scope.runtimeAccountId,
      epoch: scope.epoch,
    }),
  };
}

/**
 * Derive the capability key from the configured vault key. Fail closed if the
 * key is absent — a hosted account cannot exist without it (the token was
 * encrypted with the same key upstream).
 */
function hostedCapabilityKey(): Buffer {
  const raw = process.env.CHANNEL_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new ConfigGenError('CHANNEL_TOKEN_ENCRYPTION_KEY is required to mint a hosted channel');
  }
  return deriveCapabilityKey(raw);
}

/** The capability scope for a hosted account, drawn from the connection row. */
function scopeOf(options: HostedChannelAccountOptions): CapabilityScope {
  return {
    connectionId: options.connectionId,
    accountId: options.accountId,
    channel: options.channel,
    runtimeAccountId: options.runtimeAccountId,
    epoch: options.capabilityEpoch,
  };
}

function ensureHostedSecretProvider(config: OpenClawConfig): boolean {
  const secrets = objectAt(config, 'secrets', 'secrets');
  const providers = objectAt(secrets, 'providers', 'secrets.providers');
  const desired = {
    source: 'exec',
    command: EDEN_CHANNEL_SECRET_RESOLVER_COMMAND,
    args: ['--socket', EDEN_CHANNEL_SECRET_RESOLVER_SOCKET],
    passEnv: [
      'EDEN_CHANNEL_REQUESTER_KEY',
      'EDEN_CHANNEL_REQUESTER_INSTANCE_ID',
    ],
    jsonOnly: true,
    timeoutMs: 5_000,
    noOutputTimeoutMs: 5_000,
    maxOutputBytes: 262_144,
  };
  return setHostedValue(providers, EDEN_CHANNEL_SECRET_PROVIDER_ID, desired);
}

function ensureHostedPluginAllowed(config: OpenClawConfig, channel: HostedChannelKind): boolean {
  const plugins = objectAt(config, 'plugins', 'plugins');
  const raw = plugins.allow;
  if (raw !== undefined && (!Array.isArray(raw) || !raw.every((id) => typeof id === 'string'))) {
    throw new ConfigGenError('openclaw.json: plugins.allow must be an array of strings');
  }
  const allow = raw === undefined ? [] : [...(raw as string[])];
  let changed = false;
  for (const pluginId of [channel, EDEN_CHANNEL_RUNTIME_PLUGIN_ID]) {
    if (!allow.includes(pluginId)) {
      allow.push(pluginId);
      changed = true;
    }
  }
  if (changed) plugins.allow = allow;

  const load = objectAt(plugins, 'load', 'plugins.load');
  const rawPaths = load.paths;
  if (
    rawPaths !== undefined &&
    (!Array.isArray(rawPaths) || !rawPaths.every((pluginPath) => typeof pluginPath === 'string'))
  ) {
    throw new ConfigGenError('openclaw.json: plugins.load.paths must be an array of strings');
  }
  const paths = rawPaths === undefined ? [] : [...(rawPaths as string[])];
  if (!paths.includes(EDEN_CHANNEL_RUNTIME_PLUGIN_PATH)) {
    paths.push(EDEN_CHANNEL_RUNTIME_PLUGIN_PATH);
    load.paths = paths;
    changed = true;
  }

  const entries = objectAt(plugins, 'entries', 'plugins.entries');
  const rawEntry = entries[EDEN_CHANNEL_RUNTIME_PLUGIN_ID] ?? {};
  if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
    throw new ConfigGenError(
      `openclaw.json: plugins.entries.${EDEN_CHANNEL_RUNTIME_PLUGIN_ID} must be an object`,
    );
  }
  const entry = rawEntry as Record<string, unknown>;
  const rawHooks = entry.hooks ?? {};
  if (typeof rawHooks !== 'object' || rawHooks === null || Array.isArray(rawHooks)) {
    throw new ConfigGenError(
      `openclaw.json: plugins.entries.${EDEN_CHANNEL_RUNTIME_PLUGIN_ID}.hooks must be an object`,
    );
  }
  const hooks = rawHooks as Record<string, unknown>;
  const desiredEntry = {
    ...entry,
    enabled: true,
    hooks: {
      ...hooks,
      allowConversationAccess: true,
      allowPromptInjection: true,
    },
  };
  if (JSON.stringify(entry) !== JSON.stringify(desiredEntry)) {
    entries[EDEN_CHANNEL_RUNTIME_PLUGIN_ID] = desiredEntry;
    changed = true;
  }
  return changed;
}

function hostedGroups(options: HostedChannelAccountOptions, allowFrom: string[]): HostedChannelRuntimeGroup[] {
  const groups: HostedChannelRuntimeGroup[] = [];
  if ((options.discordGuilds?.length ?? 0) > 100 || (options.telegramGroups?.length ?? 0) > 100) {
    throw new ConfigGenError('hosted channel groups cannot exceed 100 entries');
  }
  if (options.channel === 'discord') {
    if ((options.telegramGroups?.length ?? 0) > 0) {
      throw new ConfigGenError('Telegram groups cannot be projected into a Discord account');
    }
    for (const selection of options.discordGuilds ?? []) {
      if (!/^\d{3,25}$/.test(selection.guildId) || selection.channelIds.length > 100) {
        throw new ConfigGenError('invalid hosted Discord guild selection');
      }
      for (const channelId of selection.channelIds) {
        if (!/^\d{3,25}$/.test(channelId)) {
          throw new ConfigGenError('invalid hosted Discord channel id');
        }
        groups.push({
          conversationId: channelId,
          guildId: selection.guildId,
          allowFrom: [...allowFrom],
          mentionRequired: true,
        });
      }
    }
  } else {
    if ((options.discordGuilds?.length ?? 0) > 0) {
      throw new ConfigGenError('Discord guilds cannot be projected into a Telegram account');
    }
    for (const selection of options.telegramGroups ?? []) {
      if (!/^-\d{3,25}$/.test(selection.groupId)) {
        throw new ConfigGenError('invalid hosted Telegram group id');
      }
      groups.push({
        conversationId: selection.groupId,
        guildId: null,
        allowFrom: [...allowFrom],
        mentionRequired: true,
      });
    }
  }
  const keys = groups.map((group) => `${group.guildId ?? ''}\0${group.conversationId}`);
  if (new Set(keys).size !== keys.length) throw new ConfigGenError('hosted channel groups must be unique');
  if (groups.length > 0 && allowFrom.length === 0) {
    throw new ConfigGenError('hosted group delivery requires at least one allowFrom id');
  }
  return groups;
}

function isHostedAccountBinding(
  binding: HostedBindingEntry,
  channel: HostedChannelKind,
  runtimeAccountId: string,
): boolean {
  return binding?.match?.channel === channel && binding?.match?.accountId === runtimeAccountId;
}

/**
 * Project one Eden connection as an isolated named OpenClaw channel account.
 *
 * The only credential persisted is an exec SecretRef. The referenced command
 * talks to an API-owned Unix socket; it receives neither DATABASE_URL nor the
 * AES key. Routing matches the channel account (not a peer), while
 * `per-account-channel-peer` keeps every external sender in a separate OpenClaw
 * session before Eden sync-back.
 */
export async function ensureHostedChannelAccount(
  options: HostedChannelAccountOptions,
): Promise<{ changed: boolean; config: OpenClawConfig }> {
  validateHostedAccountIdentity(options.runtimeAccountId, options.connectionId);
  const allowFrom = normalizedAllowFrom(options.allowFrom);
  if (options.dmPolicy === 'allowlist' && allowFrom.length === 0) {
    throw new ConfigGenError('allowlist channel accounts require at least one allowFrom id');
  }
  const groups = hostedGroups(options, allowFrom);

  const capKey = hostedCapabilityKey();
  const dataDir = options.dataDir ?? resolveDataDir();
  const mutation = await mutateOpenClawConfig(dataDir, (config) => {
    let changed = false;
    if (ensureHostedSecretProvider(config)) changed = true;
    if (ensureHostedPluginAllowed(config, options.channel)) changed = true;

    const session = objectAt(config, 'session', 'session');
    if (setHostedValue(session, 'dmScope', 'per-account-channel-peer')) changed = true;

    const channels = objectAt(config, 'channels', 'channels');
    const channelConfig = objectAt(channels, options.channel, `channels.${options.channel}`);
    const accounts = objectAt(
      channelConfig,
      'accounts',
      `channels.${options.channel}.accounts`,
    );

    // Eden's hosted accounts are explicit. Remove the legacy single-account
    // credential/policy fields so an env fallback cannot start a duplicate bot
    // and Telegram's top-level restrictive allowlist cannot shadow an account.
    for (const key of ['token', 'botToken', 'dmPolicy', 'allowFrom']) {
      if (deleteHostedValue(channelConfig, key)) changed = true;
    }
    if (setHostedValue(channelConfig, 'enabled', true)) changed = true;
    if (setHostedValue(channelConfig, 'configWrites', false)) changed = true;
    if (
      options.channel === 'discord' &&
      setHostedValue(channelConfig, 'healthMonitor', { enabled: false })
    ) {
      // Native Discord gateway resume owns transient reconnects. The upstream
      // outer monitor replaces the provider and recreated the R3.8 storm.
      changed = true;
    }
    if (
      options.channel === 'telegram' &&
      setHostedValue(channelConfig, 'streaming', { mode: 'off' })
    ) {
      // OpenClaw 2026.7.1's preview-finalized path emits no typed
      // message_sent event, so it cannot carry Eden's opaque run identity.
      // Hosted turns use normal final delivery until upstream exposes exact
      // preview-final correlation. Media, errors, and approvals still work.
      changed = true;
    }

    const account = {
      enabled: true,
      name: options.label?.trim() || options.runtimeAccountId,
      ...(options.channel === 'discord'
        ? { token: hostedChannelSecretRef(scopeOf(options), capKey) }
        : { botToken: hostedChannelSecretRef(scopeOf(options), capKey) }),
      dmPolicy: options.dmPolicy,
      allowFrom,
      groupPolicy: groups.length > 0 ? 'allowlist' : 'disabled',
      ...(options.channel === 'discord' && groups.length > 0
        ? {
            guilds: Object.fromEntries(
              [...new Set(groups.map((group) => group.guildId!))].map((guildId) => [
                guildId,
                {
                  users: [...allowFrom],
                  requireMention: true,
                  channels: Object.fromEntries(
                    groups
                      .filter((group) => group.guildId === guildId)
                      .map((group) => [
                        group.conversationId,
                        {
                          enabled: true,
                          requireMention: true,
                          users: [...allowFrom],
                        },
                      ]),
                  ),
                },
              ]),
            ),
          }
        : {}),
      ...(options.channel === 'telegram' && groups.length > 0
        ? {
            groupAllowFrom: [...allowFrom],
            groups: Object.fromEntries(
              groups.map((group) => [
                group.conversationId,
                { enabled: true, requireMention: true },
              ]),
            ),
          }
        : {}),
    };
    if (setHostedValue(accounts, options.runtimeAccountId, account)) changed = true;

    const accountIds = Object.keys(accounts).sort();
    const currentDefault = channelConfig.defaultAccount;
    if (typeof currentDefault !== 'string' || !(currentDefault in accounts)) {
      if (setHostedValue(channelConfig, 'defaultAccount', accountIds[0])) changed = true;
    }

    const bindings = hostedBindingsOf(config);
    const desiredBinding: HostedBindingEntry = {
      agentId: options.bindAgentId,
      match: { channel: options.channel, accountId: options.runtimeAccountId },
    };
    const existingIndex = bindings.findIndex((binding) =>
      isHostedAccountBinding(binding, options.channel, options.runtimeAccountId),
    );
    if (existingIndex === -1) {
      bindings.push(desiredBinding);
      config.bindings = bindings;
      changed = true;
    } else if (JSON.stringify(bindings[existingIndex]) !== JSON.stringify(desiredBinding)) {
      bindings[existingIndex] = desiredBinding;
      changed = true;
    }

    if (
      upsertHostedChannelRuntimeMapping(config, {
        channel: options.channel,
        accountId: options.runtimeAccountId,
        connectionId: options.connectionId,
        agentId: options.bindAgentId,
        ...(options.bindingId ? { bindingId: options.bindingId } : {}),
        ...(groups.length > 0 ? { groups } : {}),
      })
    ) {
      changed = true;
    }

    return changed;
  });
  return { changed: mutation.changed, config: mutation.config };
}

/** Pause or delete exactly one named account; unrelated bots stay active. */
export async function removeHostedChannelAccount(
  options: RemoveHostedChannelAccountOptions,
): Promise<{ changed: boolean; config: OpenClawConfig }> {
  if (!RUNTIME_ACCOUNT_ID.test(options.runtimeAccountId)) {
    throw new ConfigGenError('invalid hosted channel runtimeAccountId');
  }
  const dataDir = options.dataDir ?? resolveDataDir();
  const mutation = await mutateOpenClawConfig(dataDir, (config) => {
    let changed = false;

    const channels = config.channels as Record<string, unknown> | undefined;
    const channelConfig = channels?.[options.channel] as Record<string, unknown> | undefined;
    const accounts = channelConfig?.accounts as Record<string, unknown> | undefined;
    const account = accounts?.[options.runtimeAccountId] as Record<string, unknown> | undefined;
    if (account) {
      if (options.deleteAccount === true) {
        delete accounts![options.runtimeAccountId];
        changed = true;
      } else if (setHostedValue(account, 'enabled', false)) {
        changed = true;
      }
    }

    if (Array.isArray(config.bindings)) {
      const kept = (config.bindings as HostedBindingEntry[]).filter(
        (binding) => !isHostedAccountBinding(binding, options.channel, options.runtimeAccountId),
      );
      if (kept.length !== config.bindings.length) {
        config.bindings = kept;
        changed = true;
      }
    }

    if (removeHostedChannelRuntimeMapping(config, options.channel, options.runtimeAccountId)) {
      changed = true;
    }

    if (accounts && channelConfig) {
      const remainingIds = Object.keys(accounts).sort();
      if (remainingIds.length === 0 && options.deleteAccount === true) {
        delete channels![options.channel];
        changed = true;
      } else {
        const currentDefault = channelConfig.defaultAccount;
        if (typeof currentDefault !== 'string' || !(currentDefault in accounts)) {
          if (setHostedValue(channelConfig, 'defaultAccount', remainingIds[0])) changed = true;
        }
        const anyEnabled = Object.values(accounts).some(
          (candidate) =>
            typeof candidate === 'object' &&
            candidate !== null &&
            !Array.isArray(candidate) &&
            (candidate as Record<string, unknown>).enabled !== false,
        );
        if (setHostedValue(channelConfig, 'enabled', anyEnabled)) changed = true;
      }
    }

    return changed;
  });
  return { changed: mutation.changed, config: mutation.config };
}
