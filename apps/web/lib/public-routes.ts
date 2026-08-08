/** Only opaque, unlisted share permalinks bypass the authenticated cockpit. */
export function isPublicSharePath(pathname: string): boolean {
  return /^\/share\/[^/]+\/?$/.test(pathname);
}

const LEGAL_PATHS = new Set([
  "/legal",
  "/legal/terms",
  "/legal/privacy",
  "/legal/content",
  "/legal/cookies",
]);

/** Exact, static legal documents are public; nested/lookalike paths stay gated. */
export function isPublicLegalPath(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  return LEGAL_PATHS.has(normalized);
}

export function isPublicRoutePath(pathname: string): boolean {
  return isPublicSharePath(pathname) || isPublicLegalPath(pathname);
}
