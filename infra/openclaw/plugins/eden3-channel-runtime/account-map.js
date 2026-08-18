const SUPPORTED_CHANNELS = ['discord', 'telegram'];
const CONNECTION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIME_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REQUIRED_MAPPING_KEYS = [
  'accountId',
  'agentId',
  'agentRuntime',
  'channel',
  'connectionId',
  'model',
];
const OPTIONAL_MAPPING_KEYS = ['bindingId', 'groups'];
const GROUP_KEYS = ['allowFrom', 'conversationId', 'guildId', 'mentionRequired'];

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function configuredModelRef(config, agentId) {
  const agents = record(config?.agents);
  const list = Array.isArray(agents?.list) ? agents.list : [];
  const matches = list.filter((candidate) => record(candidate)?.id === agentId);
  if (matches.length !== 1) return undefined;
  const agent = record(matches[0]);
  const defaults = record(agents?.defaults);
  const raw = agent?.model ?? defaults?.model;
  if (typeof raw === 'string') return raw.trim();
  const primary = record(raw)?.primary;
  return typeof primary === 'string' ? primary.trim() : undefined;
}

function parseModelRef(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return undefined;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return undefined;
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(provider) || /\s/.test(model)) {
    return undefined;
  }
  return { ref: value, provider, model };
}

function configuredAgentRuntime(config, agentId, modelRef) {
  const agents = record(config?.agents);
  const list = Array.isArray(agents?.list) ? agents.list : [];
  const agent = record(list.find((candidate) => record(candidate)?.id === agentId));
  const defaults = record(agents?.defaults);
  const agentModel = record(record(agent?.models)?.[modelRef]);
  const defaultModel = record(record(defaults?.models)?.[modelRef]);
  const id = record(agentModel?.agentRuntime)?.id ?? record(defaultModel?.agentRuntime)?.id;
  return id === 'claude-cli' ? 'claude-cli' : 'openclaw';
}

function accountKey(channel, runtimeAccountId) {
  return `${channel}\0${runtimeAccountId}`;
}

function runtimeMappings(rawPluginConfig) {
  const pluginConfig = record(rawPluginConfig);
  return Array.isArray(pluginConfig?.accounts) ? pluginConfig.accounts : undefined;
}

function parseRuntimeMapping(raw) {
  const mapping = record(raw);
  const keys = Object.keys(mapping ?? {}).sort();
  if (
    !mapping ||
    REQUIRED_MAPPING_KEYS.some((key) => !keys.includes(key)) ||
    keys.some((key) => !REQUIRED_MAPPING_KEYS.includes(key) && !OPTIONAL_MAPPING_KEYS.includes(key))
  ) {
    return undefined;
  }
  if (
    !SUPPORTED_CHANNELS.includes(mapping.channel) ||
    typeof mapping.accountId !== 'string' ||
    !RUNTIME_ACCOUNT_ID.test(mapping.accountId) ||
    typeof mapping.connectionId !== 'string' ||
    !CONNECTION_UUID.test(mapping.connectionId) ||
    typeof mapping.agentId !== 'string' ||
    mapping.agentId.length === 0 ||
    (mapping.bindingId !== undefined &&
      (typeof mapping.bindingId !== 'string' || !CONNECTION_UUID.test(mapping.bindingId))) ||
    (mapping.agentRuntime !== 'openclaw' && mapping.agentRuntime !== 'claude-cli')
  ) {
    return undefined;
  }
  const model = parseModelRef(mapping.model);
  if (!model) return undefined;
  const rawGroups = mapping.groups ?? [];
  if (!Array.isArray(rawGroups) || rawGroups.length > 100) return undefined;
  const groups = [];
  const seenGroups = new Set();
  for (const rawGroup of rawGroups) {
    const group = record(rawGroup);
    if (
      !group ||
      JSON.stringify(Object.keys(group).sort()) !== JSON.stringify(GROUP_KEYS) ||
      typeof group.conversationId !== 'string' ||
      !/^-?\d{3,25}$/.test(group.conversationId) ||
      (group.guildId !== null &&
        (typeof group.guildId !== 'string' || !/^\d{3,25}$/.test(group.guildId))) ||
      group.mentionRequired !== true ||
      !Array.isArray(group.allowFrom) ||
      group.allowFrom.length === 0 ||
      group.allowFrom.length > 100 ||
      group.allowFrom.some((id) => typeof id !== 'string' || !/^-?\d{3,25}$/.test(id)) ||
      new Set(group.allowFrom).size !== group.allowFrom.length
    ) {
      return undefined;
    }
    const groupKey = `${group.guildId ?? ''}\0${group.conversationId}`;
    if (seenGroups.has(groupKey)) return undefined;
    seenGroups.add(groupKey);
    groups.push(Object.freeze({
      conversationId: group.conversationId,
      guildId: group.guildId,
      mentionRequired: true,
      allowFrom: Object.freeze([...group.allowFrom]),
    }));
  }
  return {
    channel: mapping.channel,
    runtimeAccountId: mapping.accountId,
    connectionId: mapping.connectionId.toLowerCase(),
    agentId: mapping.agentId,
    ...(mapping.bindingId ? { bindingId: mapping.bindingId.toLowerCase() } : {}),
    model,
    agentRuntime: mapping.agentRuntime,
    ...(groups.length > 0 ? { groups: Object.freeze(groups) } : {}),
  };
}

/**
 * Build the only authoritative native-channel -> Eden connection mapping.
 *
 * OpenClaw resolves SecretRefs before exposing config.current(), so credential
 * fields may contain plaintext at this boundary. This function deliberately
 * never reads token/botToken. The non-secret plugin mapping is validated
 * against account existence, DM-only policy, one binding, agent, model, and
 * runtime from the same immutable config snapshot.
 */
export function buildHostedChannelAccountMap(config, pluginConfig) {
  const accounts = new Map();
  const invalid = new Set();
  let globallyInvalid = false;
  // The manifest-validated api.pluginConfig is the sole connection-id source.
  // Never rediscover this mapping by walking config.current(): that snapshot
  // contains resolved provider credentials in 2026.7.1.
  const rawMappings = runtimeMappings(pluginConfig);
  const connectionOwners = new Map();
  const seenRoutes = new Set();
  const mappings = [];

  for (const raw of rawMappings ?? []) {
    const mapping = parseRuntimeMapping(raw);
    if (!mapping) {
      globallyInvalid = true;
      continue;
    }
    const key = accountKey(mapping.channel, mapping.runtimeAccountId);
    if (seenRoutes.has(key)) invalid.add(key);
    seenRoutes.add(key);
    connectionOwners.set(
      mapping.connectionId,
      (connectionOwners.get(mapping.connectionId) ?? 0) + 1,
    );
    mappings.push(mapping);
  }

  const channels = record(config?.channels);
  const bindings = Array.isArray(config?.bindings) ? config.bindings : [];
  for (const mapping of mappings) {
    const key = accountKey(mapping.channel, mapping.runtimeAccountId);
    const channelConfig = record(channels?.[mapping.channel]);
    const namedAccounts = record(channelConfig?.accounts);
    // Do not enumerate or inspect credential properties on the account.
    const account = record(namedAccounts?.[mapping.runtimeAccountId]);
    const matchingBindings = bindings.filter((rawBinding) => {
      const binding = record(rawBinding);
      const match = record(binding?.match);
      return match?.channel === mapping.channel && match?.accountId === mapping.runtimeAccountId;
    });
    const binding = record(matchingBindings[0]);
    const configuredModel = configuredModelRef(config, mapping.agentId);
    if (
      invalid.has(key) ||
      connectionOwners.get(mapping.connectionId) !== 1 ||
      !channelConfig ||
      channelConfig.enabled === false ||
      !account ||
      account.enabled === false ||
      account.groupPolicy !== (mapping.groups?.length > 0 ? 'allowlist' : 'disabled') ||
      matchingBindings.length !== 1 ||
      binding?.agentId !== mapping.agentId ||
      configuredModel !== mapping.model.ref ||
      configuredAgentRuntime(config, mapping.agentId, mapping.model.ref) !== mapping.agentRuntime
    ) {
      invalid.add(key);
      continue;
    }
    accounts.set(key, Object.freeze(mapping));
  }

  // A named, enabled, account-bound Discord/Telegram account without the
  // non-secret Eden mapping must never fall through to an unmetered provider.
  for (const channel of SUPPORTED_CHANNELS) {
    const channelConfig = record(channels?.[channel]);
    if (!channelConfig || channelConfig.enabled === false) continue;
    const namedAccounts = record(channelConfig.accounts);
    if (!namedAccounts) continue;
    for (const [runtimeAccountId, rawAccount] of Object.entries(namedAccounts)) {
      const account = record(rawAccount);
      if (!account || account.enabled === false) continue;
      const hasBinding = bindings.some((rawBinding) => {
        const match = record(record(rawBinding)?.match);
        return match?.channel === channel && match?.accountId === runtimeAccountId;
      });
      if (hasBinding && !seenRoutes.has(accountKey(channel, runtimeAccountId))) {
        invalid.add(accountKey(channel, runtimeAccountId));
      }
    }
  }

  return {
    list: () => (globallyInvalid ? [] : [...accounts.values()]),
    resolve(channel, runtimeAccountId) {
      if (!SUPPORTED_CHANNELS.includes(channel) || typeof runtimeAccountId !== 'string') {
        return { kind: 'not-hosted' };
      }
      const key = accountKey(channel, runtimeAccountId);
      if (globallyInvalid || invalid.has(key)) return { kind: 'invalid' };
      const mapping = accounts.get(key);
      return mapping ? { kind: 'valid', mapping } : { kind: 'not-hosted' };
    },
  };
}

export const hostedChannelAccountMapInternals = {
  parseModelRef,
  parseRuntimeMapping,
};
