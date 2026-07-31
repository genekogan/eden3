import { pg } from '@eden3/db';

export const MAX_PROVIDER_TURN_MS = 30 * 60 * 1000;
/** Strictly beyond the runtime ceiling; refreshed well before expiry. */
export const SUBSCRIPTION_TURN_LEASE_MS = 35 * 60 * 1000;
export const SUBSCRIPTION_TURN_HEARTBEAT_MS = 60 * 1000;

export interface SubscriptionTurnLease {
  release(): Promise<void>;
}

export interface SubscriptionTurnClaimsLike {
  acquire(params: {
    sessionKey: string;
    turnId: string;
    onError?: (err: unknown, context: string) => void;
  }): Promise<SubscriptionTurnLease | null>;
}

/**
 * A Postgres-backed, cross-process lease. The primary key is the gateway
 * session key, and the conditional conflict update is the only stale-claim
 * takeover path. A rejected caller has not debited manna or persisted a user
 * message yet.
 */
export class PostgresSubscriptionTurnClaims implements SubscriptionTurnClaimsLike {
  constructor(
    private readonly options: {
      now?: () => Date;
      leaseMs?: number;
      heartbeatMs?: number;
    } = {},
  ) {}

  async acquire(params: {
    sessionKey: string;
    turnId: string;
    onError?: (err: unknown, context: string) => void;
  }): Promise<SubscriptionTurnLease | null> {
    const now = this.options.now?.() ?? new Date();
    const leaseMs = this.options.leaseMs ?? SUBSCRIPTION_TURN_LEASE_MS;
    const heartbeatMs = this.options.heartbeatMs ?? SUBSCRIPTION_TURN_HEARTBEAT_MS;
    const expiresAt = new Date(now.getTime() + leaseMs);
    const [claimed] = await pg<{ turn_id: string }[]>`
      insert into claude_session_turn_claims (
        session_key, turn_id, claimed_at, lease_expires_at, updated_at
      ) values (
        ${params.sessionKey}, ${params.turnId}, ${now.toISOString()},
        ${expiresAt.toISOString()}, ${now.toISOString()}
      )
      on conflict (session_key) do update set
        turn_id = excluded.turn_id,
        claimed_at = excluded.claimed_at,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at
      where claude_session_turn_claims.lease_expires_at <= excluded.claimed_at
      returning turn_id
    `;
    if (claimed?.turn_id !== params.turnId) return null;

    let released = false;
    let renewing = false;
    const renew = async (): Promise<void> => {
      if (released || renewing) return;
      renewing = true;
      try {
        const heartbeatAt = this.options.now?.() ?? new Date();
        const heartbeatExpiry = new Date(heartbeatAt.getTime() + leaseMs);
        const rows = await pg<{ turn_id: string }[]>`
          update claude_session_turn_claims set
            lease_expires_at = ${heartbeatExpiry.toISOString()},
            updated_at = ${heartbeatAt.toISOString()}
          where session_key = ${params.sessionKey} and turn_id = ${params.turnId}
          returning turn_id
        `;
        if (rows.length === 0) {
          params.onError?.(
            new Error(`subscription turn lease was lost for ${params.sessionKey}`),
            'subscription turn lease heartbeat',
          );
        }
      } catch (err) {
        params.onError?.(err, 'subscription turn lease heartbeat');
      } finally {
        renewing = false;
      }
    };
    const timer = setInterval(() => void renew(), heartbeatMs);
    timer.unref?.();

    return {
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        await pg`
          delete from claude_session_turn_claims
          where session_key = ${params.sessionKey} and turn_id = ${params.turnId}
        `;
      },
    };
  }
}
