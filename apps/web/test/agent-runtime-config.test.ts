import { describe, expect, it } from "vitest";

import {
  MODEL_TIER_OPTIONS,
  THINKING_LEVEL_OPTIONS,
  TOOL_GROUP_OPTIONS,
  normalizeAgentModel,
  normalizeThinkingLevel,
  normalizeToolGroups,
} from "../components/agents/runtime-config";

describe("agent runtime config options", () => {
  it("exposes progressive model tiers and thinking levels", () => {
    expect(MODEL_TIER_OPTIONS.map((option) => option.label)).toEqual([
      "Fast",
      "Balanced",
      "Deep",
    ]);
    expect(THINKING_LEVEL_OPTIONS.map((option) => option.value)).toEqual([
      "fast",
      "balanced",
      "deep",
    ]);
    expect(TOOL_GROUP_OPTIONS.map((option) => option.value)).toEqual([
      "group:runtime",
      "group:fs",
      "group:web",
      "group:sessions",
      "group:memory",
      "group:media",
      "group:ui",
      "group:automation",
      "group:agents",
      "group:plugins",
    ]);
  });

  it("falls back to launch defaults for unknown imported values", () => {
    expect(normalizeAgentModel("anthropic/claude-sonnet-4-5")).toBe(
      "anthropic/claude-sonnet-4-5",
    );
    expect(normalizeAgentModel("not-a-launch-model")).toBe(
      "anthropic/claude-haiku-4-5",
    );
    expect(normalizeThinkingLevel("deep")).toBe("deep");
    expect(normalizeThinkingLevel("maximum")).toBe("balanced");
    expect(normalizeToolGroups(["group:web", "not-real", "group:web"])).toEqual([
      "group:web",
    ]);
    expect(normalizeToolGroups(["not-real"])).toEqual([
      "group:runtime",
      "group:fs",
      "group:web",
      "group:sessions",
      "group:memory",
      "group:media",
      "group:ui",
      "group:automation",
      "group:agents",
      "group:plugins",
    ]);
    expect(normalizeToolGroups([])).toEqual([]);
  });
});
