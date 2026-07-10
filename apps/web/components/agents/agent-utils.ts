/**
 * Pure helpers for the agents surface (directory, profile, create/edit).
 * No React in here — colocated unit tests live in agent-utils.test.ts.
 */

import { ApiError, isEndpointMissing } from "@/lib/api";
import type { AgentDto } from "@/lib/types";

// ---------------------------------------------------------------------------
// Username rules (create form; checked before hitting the availability probe)
// ---------------------------------------------------------------------------

export const USERNAME_MIN = 2;
export const USERNAME_MAX = 32;
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Route segments that can never be agent usernames. */
export const RESERVED_USERNAMES = new Set(["new", "builder", "edit", "api", "media"]);

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Validation message for a candidate username, or null when it's fine. */
export function usernameError(raw: string): string | null {
  const username = normalizeUsername(raw);
  if (username.length === 0) return "Pick a username";
  if (username.length < USERNAME_MIN)
    return `At least ${USERNAME_MIN} characters`;
  if (username.length > USERNAME_MAX)
    return `At most ${USERNAME_MAX} characters`;
  if (!USERNAME_RE.test(username))
    return "Lowercase letters, numbers, - and _ only; start with a letter or number";
  if (RESERVED_USERNAMES.has(username)) return `“${username}” is reserved`;
  return null;
}

export type UsernameAvailability =
  | "idle"
  | "checking"
  | "available"
  | "taken"
  | "unknown";

/**
 * Interpret an availability probe (GET /api/agents/:username) result:
 * a 200 means the name is taken, a 404 means it's free, and anything else
 * (501 while the api lands, network down) is inconclusive — don't block.
 * Pass `null` when the GET succeeded, the caught error otherwise.
 */
export function availabilityFromProbe(error: unknown | null): UsernameAvailability {
  if (error === null) return "taken";
  if (error instanceof ApiError && error.status === 404) return "available";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Loose readers — fields the api MAY embed beyond the zod DTO (render only
// when provided; never invent values)
// ---------------------------------------------------------------------------

function rec(agent: AgentDto): Record<string, unknown> {
  return agent as unknown as Record<string, unknown>;
}

/** Session count, when the directory endpoint embeds one. */
export function sessionCountOf(agent: AgentDto): number | null {
  for (const key of ["sessionCount", "session_count", "sessionsCount"]) {
    const value = rec(agent)[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

/** Whether the persona is flagged public on the wire (default: private). */
export function isPersonaPublic(agent: AgentDto): boolean {
  for (const key of ["isPersonaPublic", "is_persona_public", "personaPublic"]) {
    const value = rec(agent)[key];
    if (typeof value === "boolean") return value;
  }
  return false;
}

/** Embedded owner account summary, when the api joins it in. */
export function embeddedOwner(
  agent: AgentDto,
): { username: string; name: string | null } | null {
  const value = rec(agent)["owner"];
  if (value && typeof value === "object") {
    const owner = value as Record<string, unknown>;
    if (typeof owner.username === "string" && owner.username) {
      return {
        username: owner.username,
        name: typeof owner.name === "string" ? owner.name : null,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Provisioning (POST /api/agents -> pending/provisioning -> ready|failed;
// tolerate a legacy "provisioned" spelling for done)
// ---------------------------------------------------------------------------

export const PROVISION_POLL_MS = 3000;
export const PROVISION_POLL_MAX = 100; // ~5 minutes, then stop quietly

export function isProvisionPending(status: string | null | undefined): boolean {
  return status === "pending" || status === "provisioning";
}

/**
 * "pending" = dormant, nothing running. Migrated agents sit here until their
 * FIRST chat message triggers lazy provisioning server-side — so chat must
 * stay available; it is the wake-up trigger, not something to wait behind.
 */
export function isProvisionQueued(status: string | null | undefined): boolean {
  return status === "pending";
}

/** "provisioning" = a first turn is actively warming the runtime right now. */
export function isProvisionWarming(status: string | null | undefined): boolean {
  return status === "provisioning";
}

export function isProvisionFailed(status: string | null | undefined): boolean {
  return status === "failed";
}

/** Badge copy for dormant/in-flight/failed provisioning; null when nothing to show. */
export function provisionLabel(status: string | null | undefined): string | null {
  if (status === "pending") return "Wakes on first chat";
  if (status === "provisioning") return "Provisioning…";
  if (status === "failed") return "Provision failed";
  return null; // ready / provisioned / unknown -> no badge
}

// ---------------------------------------------------------------------------
// Shared list plumbing + error copy
// ---------------------------------------------------------------------------

/** Append-dedupe for cursor pagination (pages can overlap while data moves). */
export function dedupeById<T extends { id: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/** Human copy for a failed agents call (list / profile / save). */
export function describeApiFailure(error: unknown): string {
  if (isEndpointMissing(error)) {
    return "This API route hasn't landed yet — the page will light up on its own.";
  }
  if (error instanceof ApiError) return `API error ${error.status}`;
  return "Can't reach the API — is @eden3/api running on :4301?";
}

/** Server-provided detail for a failed save (POST/PATCH), best effort. */
export function apiErrorDetail(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.body && typeof error.body === "object") {
      const body = error.body as Record<string, unknown>;
      const message = body.message ?? body.error;
      if (typeof message === "string" && message) return message;
    }
    return describeApiFailure(error);
  }
  return error instanceof Error && error.message
    ? error.message
    : "Something went wrong";
}
