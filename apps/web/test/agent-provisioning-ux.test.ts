/**
 * Lazy-provisioning UX contract. Migrated agents sit at status "pending"
 * (dormant) until their FIRST chat provisions them server-side — so the
 * profile must keep Chat available while queued (it is the wake-up trigger)
 * and only block during an active warm-up or after a failure. A regression
 * here deadlocks every migrated non-pilot agent behind a "chat unlocks when
 * ready" state that nothing can ever satisfy.
 */
import { describe, expect, it } from "vitest";

import {
  isProvisionFailed,
  isProvisionPending,
  isProvisionQueued,
  isProvisionWarming,
  provisionLabel,
} from "@/components/agents/agent-utils";

describe("provisioning status predicates", () => {
  it("distinguishes dormant (queued) from actively warming", () => {
    expect(isProvisionQueued("pending")).toBe(true);
    expect(isProvisionQueued("provisioning")).toBe(false);
    expect(isProvisionWarming("provisioning")).toBe(true);
    expect(isProvisionWarming("pending")).toBe(false);
    // The poll helper still covers both in-flight states.
    expect(isProvisionPending("pending")).toBe(true);
    expect(isProvisionPending("provisioning")).toBe(true);
    expect(isProvisionPending("ready")).toBe(false);
  });

  it("keeps chat available while queued — first chat is the provision trigger", () => {
    const chatBlocked = (status: string) =>
      isProvisionWarming(status) || isProvisionFailed(status);
    expect(chatBlocked("pending")).toBe(false); // dormant → chat must work
    expect(chatBlocked("provisioning")).toBe(true); // warm-up in flight
    expect(chatBlocked("failed")).toBe(true);
    expect(chatBlocked("ready")).toBe(false);
  });
});

describe("provision badge copy", () => {
  it("describes the dormant state truthfully (nothing is running)", () => {
    expect(provisionLabel("pending")).toBe("Wakes on first chat");
    expect(provisionLabel("provisioning")).toBe("Provisioning…");
    expect(provisionLabel("failed")).toBe("Provision failed");
    expect(provisionLabel("ready")).toBeNull();
    expect(provisionLabel(undefined)).toBeNull();
  });
});
