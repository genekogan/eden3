import { describe, expect, it } from 'vitest';

import {
  MAX_PROVIDER_TURN_MS,
  SUBSCRIPTION_TURN_HEARTBEAT_MS,
  SUBSCRIPTION_TURN_LEASE_MS,
} from '../src/services/subscription-turn-claims';

describe('subscription turn lease bounds', () => {
  it('keeps the lease strictly beyond the maximum provider turn boundary', () => {
    expect(SUBSCRIPTION_TURN_LEASE_MS).toBeGreaterThan(MAX_PROVIDER_TURN_MS);
    expect(SUBSCRIPTION_TURN_HEARTBEAT_MS).toBeLessThan(
      SUBSCRIPTION_TURN_LEASE_MS - MAX_PROVIDER_TURN_MS,
    );
  });
});
