export function verifiedSessionDraftKey(sessionId: unknown): string | null {
  return typeof sessionId === "string" && sessionId.length > 0
    ? `session:${sessionId}`
    : null;
}
