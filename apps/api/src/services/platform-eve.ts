/** Durable shared-gateway identity reserved for Eden's platform assistant. */
export const DEFAULT_EVE_USERNAME = 'eve';
export const DEFAULT_EVE_OPENCLAW_ID = 'main';

/**
 * Eve receives current-user memory from the API turn envelope, so she never
 * needs tools that can enumerate the shared workspace, memory index, sessions,
 * or subprocess filesystem. Media/web/UI retain the useful product kernel.
 */
export const PLATFORM_EVE_TOOL_GROUPS = ['group:web', 'group:media', 'group:ui'] as const;
export const PLATFORM_EVE_TOOL_ALLOWLIST = [
  'group:web',
  'group:media',
  'tts',
  'group:ui',
] as const;

/** Apply the same fail-closed policy to the live OpenClaw `main` entry. */
export function hardenPlatformEveRuntimeEntry(entry: Record<string, unknown>): void {
  const currentTools = entry.tools;
  const tools =
    typeof currentTools === 'object' && currentTools !== null && !Array.isArray(currentTools)
      ? (currentTools as Record<string, unknown>)
      : {};
  tools.allow = [...PLATFORM_EVE_TOOL_ALLOWLIST];
  entry.tools = tools;

  const currentSandbox = entry.sandbox;
  const sandbox =
    typeof currentSandbox === 'object' && currentSandbox !== null && !Array.isArray(currentSandbox)
      ? (currentSandbox as Record<string, unknown>)
      : {};
  // The API owns durable memory writes. Turns need no mutable workspace mount.
  sandbox.workspaceAccess = 'ro';
  entry.sandbox = sandbox;
}

/**
 * Product authorization guard. The runtime binding and lack of an owner are
 * durable even if the display handle briefly drifts during an upgrade.
 */
export function isPlatformEve(
  _account: { username: string },
  agent: { openclawId: string | null; ownerId: string | null },
): boolean {
  return agent.openclawId === DEFAULT_EVE_OPENCLAW_ID && agent.ownerId === null;
}

export interface PlatformEveTurnIdentity {
  username: string;
  openclawId: string;
  ownerId?: string | null;
}

/** Missing ownership data and Eve/main lookalikes fail closed. */
export function isPlatformEveTurnIdentity(identity: PlatformEveTurnIdentity): boolean {
  return (
    identity.username === DEFAULT_EVE_USERNAME &&
    identity.openclawId === DEFAULT_EVE_OPENCLAW_ID &&
    identity.ownerId === null
  );
}
