/**
 * The only browser cookies the Next server may forward to the internal API.
 * Keep this list exact: unrelated preferences and third-party cookies never
 * belong on the web -> API trust boundary.
 */
const API_AUTH_COOKIE_NAMES = ["eden3_dev_user", "__session"] as const;

export function forwardedApiAuthCookieHeader(
  readCookie: (name: (typeof API_AUTH_COOKIE_NAMES)[number]) => string | undefined,
): string | null {
  const values = API_AUTH_COOKIE_NAMES.flatMap((name) => {
    const value = readCookie(name)?.trim();
    return value ? [`${name}=${encodeURIComponent(value)}`] : [];
  });
  return values.length > 0 ? values.join("; ") : null;
}
