/**
 * Adopt a durable session identity only for the first-use reservation race.
 *
 * A command that resolved a genuinely brand-new session has no prepared
 * entry. If a durable entry appears before lifecycle admission, another
 * authorized writer won that session-key reservation and its identity is the
 * only safe one to use when OpenClaw's own reset policy still considers that
 * row fresh. Every stale, pre-existing-session, or missing-current case is left
 * unchanged so OpenClaw's normal mismatch guard can reject a rebind.
 */
export function resolveSessionAdmissionIdentity({
  isNewSession,
  preparedSessionId,
  resolvedSessionId,
  currentSessionId,
  currentFresh,
  currentStatus,
  hasRequestedSessionId,
}) {
  const canAdopt =
    isNewSession === true &&
    hasRequestedSessionId === false &&
    preparedSessionId === undefined &&
    typeof currentSessionId === 'string' &&
    currentSessionId.length > 0 &&
    currentFresh === true &&
    currentStatus === 'done';
  return canAdopt
    ? { sessionId: currentSessionId, isNewSession: false, adopted: true }
    : { sessionId: resolvedSessionId, isNewSession, adopted: false };
}
