import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import type { AgentDto } from "../../lib/types";
import {
  availabilityFromProbe,
  dedupeById,
  embeddedOwner,
  isPersonaPublic,
  isProvisionFailed,
  isProvisionPending,
  provisionLabel,
  sessionCountOf,
  usernameError,
} from "./agent-utils";

function agent(extra: Record<string, unknown> = {}): AgentDto {
  return {
    id: "6c1f5b7e-3d2a-4e8b-9f10-2a3b4c5d6e7f",
    externalId: null,
    username: "verdelis",
    name: "Verdelis",
    description: null,
    persona: null,
    greeting: null,
    voice: null,
    userImage: null,
    public: true,
    ownerId: null,
    isPilot: false,
    isSynthetic: false,
    provisionStatus: "ready",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...extra,
  } as AgentDto;
}

describe("usernameError", () => {
  it("accepts simple handles", () => {
    expect(usernameError("verdelis")).toBeNull();
    expect(usernameError("agent-2_b")).toBeNull();
    expect(usernameError("  Verdelis  ")).toBeNull(); // normalized before check
  });

  it("rejects bad shapes", () => {
    expect(usernameError("")).toMatch(/pick/i);
    expect(usernameError("a")).toMatch(/at least/i);
    expect(usernameError("x".repeat(33))).toMatch(/at most/i);
    expect(usernameError("-lead")).toMatch(/start with/i);
    expect(usernameError("has space")).toMatch(/lowercase/i);
    expect(usernameError("new")).toMatch(/reserved/i);
  });
});

describe("availabilityFromProbe", () => {
  it("200 -> taken, 404 -> available", () => {
    expect(availabilityFromProbe(null)).toBe("taken");
    expect(availabilityFromProbe(new ApiError(404, "not found"))).toBe(
      "available",
    );
  });

  it("501 / network failures are inconclusive", () => {
    expect(availabilityFromProbe(new ApiError(501, "not implemented"))).toBe(
      "unknown",
    );
    expect(availabilityFromProbe(new TypeError("fetch failed"))).toBe("unknown");
  });
});

describe("loose DTO readers", () => {
  it("reads sessionCount only when provided and sane", () => {
    expect(sessionCountOf(agent())).toBeNull();
    expect(sessionCountOf(agent({ sessionCount: 42 }))).toBe(42);
    expect(sessionCountOf(agent({ session_count: 7 }))).toBe(7);
    expect(sessionCountOf(agent({ sessionCount: -1 }))).toBeNull();
    expect(sessionCountOf(agent({ sessionCount: "12" }))).toBeNull();
  });

  it("persona defaults to private without an explicit flag", () => {
    expect(isPersonaPublic(agent())).toBe(false);
    expect(isPersonaPublic(agent({ isPersonaPublic: true }))).toBe(true);
    expect(isPersonaPublic(agent({ is_persona_public: false }))).toBe(false);
  });

  it("reads an embedded owner summary when joined in", () => {
    expect(embeddedOwner(agent())).toBeNull();
    expect(embeddedOwner(agent({ owner: { username: "gene" } }))).toEqual({
      username: "gene",
      name: null,
    });
  });
});

describe("provisioning", () => {
  it("classifies statuses", () => {
    expect(isProvisionPending("pending")).toBe(true);
    expect(isProvisionPending("provisioning")).toBe(true);
    expect(isProvisionPending("ready")).toBe(false);
    expect(isProvisionFailed("failed")).toBe(true);
  });

  it("labels only dormant/in-flight/failed states", () => {
    // "pending" is dormant (wake-on-chat), not an active queue — see
    // test/agent-provisioning-ux.test.ts for the full contract.
    expect(provisionLabel("pending")).toMatch(/first chat/i);
    expect(provisionLabel("provisioning")).toMatch(/provisioning/i);
    expect(provisionLabel("failed")).toMatch(/failed/i);
    expect(provisionLabel("ready")).toBeNull();
    expect(provisionLabel("provisioned")).toBeNull();
    expect(provisionLabel(null)).toBeNull();
  });
});

describe("dedupeById", () => {
  it("keeps first occurrence, preserves order", () => {
    const merged = dedupeById([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
      { id: "a", n: 3 },
    ]);
    expect(merged).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
  });
});
