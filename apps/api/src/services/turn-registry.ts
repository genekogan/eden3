/**
 * Turn registry — in-memory map of recently-active chat turns keyed by the
 * session's gateway key (`eden3:s:<uuid>`).
 *
 * Purpose: async media files land on disk 10-120s AFTER the HTTP turn that
 * kicked them off (spike probe #4), with filenames that do NOT carry the task
 * id. The media watcher needs to know "which eden3 sessions were active just
 * now" to correlate a fresh file (dir-snapshot + timestamps + sessions_history
 * fallback). Chat turns register here on start and extend their window on
 * completion; entries expire after {@link DEFAULT_TURN_WINDOW_MS}.
 *
 * Process-local on purpose (single api process talks to the single-tenant
 * gateway). Nothing here is durable — a restart only loses correlation hints,
 * and the history-sync path re-derives attachments from the gateway session.
 */

export interface ActiveTurn {
  /** eden3 `sessions.id`. */
  sessionId: string;
  /** Agent `accounts.id` the turn is addressed to. */
  agentAccountId: string;
  /** OpenClaw agent id (`agents.openclaw_id`) — lets consumers derive the scoped key. */
  agentOpenclawId: string;
  /** Epoch ms until which this session counts as "recently active". */
  windowUntil: number;
}

/** How long a turn keeps its session "active" for media correlation. */
export const DEFAULT_TURN_WINDOW_MS = 5 * 60_000;

const SCOPED_KEY_RE = /^agent:[^:]+:(.+)$/;

/** Normalize a gateway session key: strip one `agent:<id>:` scope prefix. */
export function plainSessionKey(key: string): string {
  const match = SCOPED_KEY_RE.exec(key);
  return match ? match[1]! : key;
}

export class TurnRegistry {
  private readonly entries = new Map<string, ActiveTurn>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Register (or refresh) the active turn for `sessionKey` (plain or scoped —
   * scoped keys are normalized). Returns the stored entry.
   */
  register(
    sessionKey: string,
    turn: Omit<ActiveTurn, 'windowUntil'>,
    windowMs = DEFAULT_TURN_WINDOW_MS,
  ): ActiveTurn {
    const entry: ActiveTurn = { ...turn, windowUntil: this.now() + windowMs };
    this.entries.set(plainSessionKey(sessionKey), entry);
    return entry;
  }

  /** Extend the window of an existing entry; no-op when absent/expired. */
  touch(sessionKey: string, windowMs = DEFAULT_TURN_WINDOW_MS): ActiveTurn | null {
    const entry = this.get(sessionKey);
    if (!entry) return null;
    entry.windowUntil = this.now() + windowMs;
    return entry;
  }

  /** Look up by plain or scoped key; expired entries read (and prune) as null. */
  get(sessionKey: string): ActiveTurn | null {
    const key = plainSessionKey(sessionKey);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.windowUntil <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  /** All live entries as `[plainSessionKey, turn]` pairs (prunes as it goes). */
  active(): Array<[string, ActiveTurn]> {
    this.prune();
    return [...this.entries.entries()];
  }

  /** Drop expired entries; returns how many were removed. */
  prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.windowUntil <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }
}
