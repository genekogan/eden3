/**
 * Last-selected-agent persistence. The selected agent lives in the URL
 * (/agents/[username]/…); this module only remembers the most recent one so
 * bare routes (/, /chats, legacy /tasks, …) can bounce somewhere sensible.
 *
 * Dual write: a cookie (readable by server redirect pages — see
 * last-agent-server.ts) plus a localStorage mirror as a client-side fallback.
 * Client-safe module: no next/headers imports here.
 */

export const LAST_AGENT_COOKIE = "eden3_last_agent";
const LOCAL_KEY = "eden3.lastAgent";
const ONE_YEAR_S = 60 * 60 * 24 * 365;

/** Usernames are handle-shaped; anything else is a stale/hostile value. */
export function isValidAgentUsername(value: string | undefined | null): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

export function setLastAgent(username: string): void {
  if (!isValidAgentUsername(username) || typeof document === "undefined") return;
  document.cookie = `${LAST_AGENT_COOKIE}=${encodeURIComponent(username)}; path=/; max-age=${ONE_YEAR_S}; samesite=lax`;
  try {
    window.localStorage.setItem(LOCAL_KEY, username);
  } catch {
    // storage full / privacy mode — cookie already written
  }
}

export function clearLastAgent(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${LAST_AGENT_COOKIE}=; path=/; max-age=0; samesite=lax`;
  try {
    window.localStorage.removeItem(LOCAL_KEY);
  } catch {
    // ignore
  }
}

/** Client-side read (localStorage first, cookie fallback). */
export function getLastAgent(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(LOCAL_KEY);
    if (isValidAgentUsername(stored)) return stored;
  } catch {
    // fall through to cookie
  }
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${LAST_AGENT_COOKIE}=([^;]+)`),
  );
  const fromCookie = match?.[1] ? decodeURIComponent(match[1]) : null;
  return isValidAgentUsername(fromCookie) ? fromCookie : null;
}
