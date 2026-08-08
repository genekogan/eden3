/** Web-side identity and navigation policy for Eden's singular assistant. */
export const EVE_USERNAME = "eve";

export function isEveUsername(username: string | null | undefined): boolean {
  return username?.trim().toLowerCase() === EVE_USERNAME;
}

/** Eve is usable, but her platform-owned configuration is absent by design. */
export function isEveConcealedSubpath(subpath: string): boolean {
  const normalized = subpath.replace(/^\/+|\/+$/g, "").toLowerCase();
  return ["edit", "settings", "schedule", "workspace", "gateway"].some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

export function agentSubpathForUsername(
  username: string,
  requested: string | null | undefined,
): string {
  if (!requested || (isEveUsername(username) && isEveConcealedSubpath(requested))) {
    return "chats";
  }
  return requested;
}

export function agentSectionHref(username: string, subpath: string): string {
  const safeSubpath = agentSubpathForUsername(username, subpath);
  return `/agents/${encodeURIComponent(username)}/${safeSubpath}`;
}

export function agentSettingsLandingHref(username: string): string {
  return isEveUsername(username)
    ? agentSectionHref(username, "chats")
    : agentSectionHref(username, "settings/identity");
}

/** True only for an Eve agent URL whose subpath is intentionally concealed. */
export function isEveConfigurationHref(
  username: string | null | undefined,
  href: string,
): boolean {
  if (!isEveUsername(username)) return false;
  const prefix = `/agents/${encodeURIComponent(username!)}/`;
  return href.startsWith(prefix) && isEveConcealedSubpath(href.slice(prefix.length));
}
