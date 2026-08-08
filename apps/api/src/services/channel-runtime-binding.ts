const RUNTIME_BINDING_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Opaque generation for one published hosted-channel mapping. Missing means
 * the pre-generation legacy mapping; malformed persisted state fails closed.
 */
export function storedChannelRuntimeBindingId(metadata: unknown): string | undefined {
  const value = record(metadata)._runtimeBindingId;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !RUNTIME_BINDING_UUID.test(value)) {
    throw new Error('invalid channel runtime binding');
  }
  return value;
}

export function channelRuntimeBindingMatches(input: {
  metadata: unknown;
  storedAgentId: string;
  requesterAgentId?: string;
  requesterBindingId?: string;
}): boolean {
  let storedBindingId: string | undefined;
  try {
    storedBindingId = storedChannelRuntimeBindingId(input.metadata);
  } catch {
    return false;
  }
  if (storedBindingId !== input.requesterBindingId) return false;
  // Legacy callers did not send either coordinate. Once a binding generation
  // exists, both are mandatory and exact.
  if (storedBindingId !== undefined) {
    return input.requesterAgentId === input.storedAgentId;
  }
  return input.requesterAgentId === undefined || input.requesterAgentId === input.storedAgentId;
}
