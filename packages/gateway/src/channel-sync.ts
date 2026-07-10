import {
  ConfigGenError,
  readOpenClawConfig,
  resolveDataDir,
  writeOpenClawConfig,
  type ConfigGenOptions,
  type OpenClawConfig,
} from './config-gen';

/**
 * Channel runtime wiring — projects eden3 channel connections into
 * openclaw.json's `channels.*` + `bindings` keys so a connected channel can
 * actually send and receive (the custody rows in Postgres are only the
 * encrypted token record + audit trail).
 *
 * Launch scope: Discord. Token custody for the RUNTIME is env-var-based:
 * the gateway container carries DISCORD_BOT_TOKEN (infra/openclaw/.env) and
 * the channel uses OpenClaw's documented bare-env fallback — NO token key is
 * written to openclaw.json at all. (Verified live on 2026.6.10: the newer
 * docs' `token: {source:'env', id}` shape is REJECTED by this release's
 * schema — allowed sources are string|file|exec — and one invalid key
 * crash-loops the gateway.) Multi-account per-user runtime tokens need
 * OpenClaw's `accounts` map; deferred until a second live connection exists.
 *
 * CAUTION (same as config-gen): the gateway validates the config schema
 * strictly — one invalid key rejects the WHOLE file. Only keys verified
 * valid on the pinned OpenClaw release are written here:
 * `channels.discord.{enabled,dmPolicy,allowFrom}` and top-level
 * `bindings[]` ({agentId, match:{channel,peer:{kind,id}}}).
 */

export interface DiscordChannelOptions extends ConfigGenOptions {
  /**
   * Env var name (inside the gateway container) holding the bot token.
   * Informational on this OpenClaw release: only the documented default
   * (DISCORD_BOT_TOKEN) is honored via the bare-env fallback, so any other
   * name is rejected loudly rather than silently not working.
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
  if (options.tokenEnvVar !== 'DISCORD_BOT_TOKEN') {
    throw new ConfigGenError(
      `ensureDiscordChannel: this OpenClaw release only reads the bare DISCORD_BOT_TOKEN env fallback (got "${options.tokenEnvVar}")`,
    );
  }
  const dataDir = options.dataDir ?? resolveDataDir();
  const config = await readOpenClawConfig(dataDir);
  let changed = false;

  const channels = (config.channels ??= {}) as Record<string, unknown>;
  const discordRaw = (channels.discord ??= {});
  if (typeof discordRaw !== 'object' || discordRaw === null || Array.isArray(discordRaw)) {
    throw new ConfigGenError('openclaw.json: channels.discord must be an object');
  }
  const discord = discordRaw as Record<string, unknown>;

  // No token key on purpose — see the module docblock (bare-env fallback).
  // Strip one left behind by the earlier env-ref attempt: it crash-loops
  // the gateway on this release.
  if ('token' in discord) {
    delete discord.token;
    changed = true;
  }
  const desired: Record<string, unknown> = {
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

  if (changed) await writeOpenClawConfig(dataDir, config);
  return { changed, config };
}

/**
 * Disable the Discord channel (keeps token reference/allowlist for a later
 * re-enable; removes the routing bindings so DMs stop reaching agents).
 */
export async function disableDiscordChannel(
  options: ConfigGenOptions = {},
): Promise<{ changed: boolean; config: OpenClawConfig }> {
  const dataDir = options.dataDir ?? resolveDataDir();
  const config = await readOpenClawConfig(dataDir);
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

  if (changed) await writeOpenClawConfig(dataDir, config);
  return { changed, config };
}
