// Server-only module (next/headers). Do not import from client components.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { LAST_AGENT_COOKIE, isValidAgentUsername } from "./last-agent";

/**
 * Server half of last-agent persistence: used by the thin redirect pages that
 * replace legacy routes (/chat, /tasks, /channels, …) and by bare shortcuts
 * (/chats). Reads the cookie written client-side by lib/last-agent.ts.
 */

/** The remembered agent username, or null. */
export async function getLastAgentFromCookies(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(LAST_AGENT_COOKIE)?.value;
  return isValidAgentUsername(value) ? value : null;
}

/**
 * Redirect to /agents/<agent>/<sub>. Precedence: an explicit ?agent= value
 * (legacy links) > the last-agent cookie > the /agents selector page.
 * Never returns (Next redirect throws).
 */
export async function redirectToAgentSub(sub: string, searchAgent?: string): Promise<never> {
  const explicit = isValidAgentUsername(searchAgent) ? searchAgent : null;
  const username = explicit ?? (await getLastAgentFromCookies());
  if (username) redirect(`/agents/${encodeURIComponent(username)}/${sub}`);
  redirect("/agents");
}
