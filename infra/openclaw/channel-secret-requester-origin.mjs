/**
 * Bind Eden channel SecretRefs to their exact active named-account origin.
 * This function is injected into the pinned OpenClaw bundle at image build.
 */
export function bindEdenChannelRequesterRefs(assignments, sourceConfig) {
  const edenChannelRequesterIds = new Set();
  return assignments.map((assignment) => {
    const ref = assignment.ref;
    if (ref?.source !== 'exec' || ref?.provider !== 'eden-channel-vault') return ref;
    const match =
      /^channels\.(discord|telegram)\.accounts\.([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.(token|botToken)$/.exec(
        assignment.path,
      );
    if (!match) throw new Error('Eden channel SecretRef has no exact named-account origin.');
    const [, channel, runtimeAccountId, credentialField] = match;
    if (credentialField !== (channel === 'discord' ? 'token' : 'botToken')) {
      throw new Error('Eden channel SecretRef credential origin mismatched its channel.');
    }
    const connection =
      /^channel\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\./.exec(
        ref.id,
      );
    if (!connection) throw new Error('Eden channel SecretRef connection identity is invalid.');
    if (edenChannelRequesterIds.has(ref.id)) {
      throw new Error('Eden channel SecretRef cannot be assigned to multiple config origins.');
    }
    edenChannelRequesterIds.add(ref.id);
    const bindings = Array.isArray(sourceConfig.bindings)
      ? sourceConfig.bindings.filter(
          (binding) =>
            binding?.match?.channel === channel &&
            binding?.match?.accountId === runtimeAccountId &&
            typeof binding?.agentId === 'string',
        )
      : [];
    if (bindings.length !== 1) {
      throw new Error('Eden channel SecretRef requires one exact channel account binding.');
    }
    return {
      ...ref,
      __edenRequester: {
        id: ref.id,
        configPath: assignment.path,
        connectionId: connection[1],
        channel,
        runtimeAccountId,
        agentId: bindings[0].agentId,
        credentialField,
      },
    };
  });
}
