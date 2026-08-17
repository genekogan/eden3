export type OwnedAgentInventoryPhase = "loading" | "ready" | "error";
export type PrivateViewerPhase = "loading" | "ready" | "signed_out" | "error";

export interface PrivateSearchAuthority {
  viewerId: string;
  generation: number;
}

export function privateSearchAuthority(
  viewerId: string | null | undefined,
  phase: PrivateViewerPhase,
  generation: number,
): PrivateSearchAuthority | null {
  return phase === "ready" && viewerId
    ? { viewerId, generation }
    : null;
}

export function privateSearchAuthorityMatches(
  admitted: PrivateSearchAuthority,
  viewerId: string | null | undefined,
  phase: PrivateViewerPhase,
  generation: number,
): boolean {
  return phase === "ready" && admitted.viewerId === viewerId && admitted.generation === generation;
}

export function authIdentityChanged(
  previous: string | null | undefined,
  current: string | null,
): boolean {
  return previous !== undefined && previous !== current;
}

/** Viewer-generation fence for browser-resident agent data. */
export class AgentCacheAuthority {
  private generation = 0;

  token(): number {
    return this.generation;
  }

  admits(token: number): boolean {
    return token === this.generation;
  }

  invalidate(cache: Map<unknown, unknown>): void {
    this.generation += 1;
    cache.clear();
  }
}

/** Owned rows are private and remain hidden until this viewer's load settles. */
export function paletteOwnedAgents<T>(
  agents: T[] | null,
  phase: OwnedAgentInventoryPhase,
  viewerPhase: PrivateViewerPhase = "ready",
): T[] {
  return phase === "ready" && viewerPhase === "ready" ? (agents ?? []) : [];
}
