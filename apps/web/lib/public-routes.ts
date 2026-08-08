/** Only opaque, unlisted share permalinks bypass the authenticated cockpit. */
export function isPublicSharePath(pathname: string): boolean {
  return /^\/share\/[^/]+\/?$/.test(pathname);
}
