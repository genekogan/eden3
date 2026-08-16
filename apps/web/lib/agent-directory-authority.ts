export type DirectoryViewerPhase = "loading" | "ready" | "signed_out" | "error";

export interface DirectoryAuthorityToken {
  viewerId: string;
  generation: number;
}

/**
 * Capture the exact viewer authority under which an owned-agent request was
 * admitted. Signed-out, unresolved, and verification-error states never
 * receive a token and therefore can never issue `scope=mine` requests.
 */
export function directoryAuthorityToken(
  viewerId: string | null,
  phase: DirectoryViewerPhase,
  generation: number,
): DirectoryAuthorityToken | null {
  if (phase !== "ready" || !viewerId || !Number.isSafeInteger(generation) || generation < 0) {
    return null;
  }
  return { viewerId, generation };
}

/** Refuse a delayed response after sign-out, verification failure, or A→B. */
export function directoryAuthorityMatches(
  token: DirectoryAuthorityToken,
  viewerId: string | null,
  phase: DirectoryViewerPhase,
  generation: number,
): boolean {
  return (
    phase === "ready" &&
    viewerId === token.viewerId &&
    generation === token.generation
  );
}

/** Render private rows only for the exact viewer that produced them. */
export function directoryRowsVisible(
  itemsViewerId: string | null,
  viewerId: string | null,
  phase: DirectoryViewerPhase,
  locallyRefused: boolean,
): boolean {
  return (
    !locallyRefused &&
    phase === "ready" &&
    viewerId !== null &&
    itemsViewerId === viewerId
  );
}
