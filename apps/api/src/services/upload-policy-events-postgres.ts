import { pg } from '@eden3/db';

import type {
  ClaimedPolicyEvent,
  UploadPolicyEventStore,
} from './upload-repository';

interface EventRow {
  id: string;
  object_id: string;
  owner_account_id: string;
  policy_code: string;
  state: ClaimedPolicyEvent['state'];
  attempt_count: number;
  claim_token: string;
}
function event(row: EventRow): ClaimedPolicyEvent {
  return {
    id: row.id,
    objectId: row.object_id,
    ownerAccountId: row.owner_account_id,
    policyCode: row.policy_code,
    state: 'delivering',
    attemptCount: row.attempt_count,
    claimToken: row.claim_token,
  };
}

export class PostgresUploadPolicyEventStore implements UploadPolicyEventStore {
  async recoverExpiredPolicyEvents(now: Date, maxAttempts: number): Promise<void> {
    await pg`
      update storage_policy_events
      set state = case when attempt_count >= ${maxAttempts} then 'failed' else 'pending' end,
          next_attempt_at = case when attempt_count >= ${maxAttempts} then null else ${now.toISOString()} end,
          claim_token = null, claim_expires_at = null, updated_at = ${now.toISOString()},
          last_error_code = 'claim_expired'
      where state = 'delivering' and claim_expires_at <= ${now.toISOString()}
    `;
  }

  async claimDuePolicyEvents(input: {
    now: Date;
    limit: number;
    leaseMs: number;
    maxAttempts: number;
  }): Promise<ClaimedPolicyEvent[]> {
    return pg.begin(async (tx) => {
      const rows = await tx<EventRow[]>`
        with due as (
          select id from storage_policy_events
          where state = 'pending' and next_attempt_at <= ${input.now.toISOString()}
            and attempt_count < ${input.maxAttempts}
          order by next_attempt_at, id
          for update skip locked
          limit ${input.limit}
        )
        update storage_policy_events e
        set state = 'delivering', attempt_count = e.attempt_count + 1,
            next_attempt_at = null, claim_token = gen_random_uuid(),
            claim_expires_at = ${new Date(input.now.getTime() + input.leaseMs).toISOString()},
            updated_at = ${input.now.toISOString()}
        from due where e.id = due.id
        returning e.id, e.object_id, e.owner_account_id, e.policy_code,
                  e.state, e.attempt_count, e.claim_token
      `;
      return rows.map(event);
    });
  }

  async markPolicyEventDelivered(eventId: string, claimToken: string, now: Date): Promise<boolean> {
    const rows = await pg<{ id: string }[]>`
      update storage_policy_events set state = 'delivered', delivered_at = ${now.toISOString()},
        next_attempt_at = null, claim_token = null, claim_expires_at = null,
        last_error_code = null, updated_at = ${now.toISOString()}
      where id = ${eventId} and state = 'delivering' and claim_token = ${claimToken}
      returning id
    `;
    return rows.length === 1;
  }

  async retryPolicyEvent(input: {
    eventId: string;
    claimToken: string;
    now: Date;
    nextAttemptAt: Date;
    maxAttempts: number;
    errorCode: string;
  }): Promise<boolean> {
    const rows = await pg<{ id: string }[]>`
      update storage_policy_events
      set state = case when attempt_count >= ${input.maxAttempts} then 'failed' else 'pending' end,
          next_attempt_at = case when attempt_count >= ${input.maxAttempts} then null else ${input.nextAttemptAt.toISOString()} end,
          claim_token = null, claim_expires_at = null, last_error_code = ${input.errorCode},
          updated_at = ${input.now.toISOString()}
      where id = ${input.eventId} and state = 'delivering' and claim_token = ${input.claimToken}
      returning id
    `;
    return rows.length === 1;
  }
}
