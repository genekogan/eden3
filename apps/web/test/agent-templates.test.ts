import { describe, expect, it } from "vitest";

import { AGENT_TEMPLATES } from "../components/agents/agent-create-form";
import { normalizeUsername, usernameError } from "../components/agents/agent-utils";

describe("agent creation templates", () => {
  it("ships a usable template gallery", () => {
    expect(AGENT_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    for (const template of AGENT_TEMPLATES) {
      expect(template.id).toBeTruthy();
      expect(template.label).toBeTruthy();
      expect(usernameError(normalizeUsername(template.username))).toBeNull();
      expect(template.name.trim().length).toBeGreaterThan(0);
      expect(template.description.trim().length).toBeGreaterThan(20);
      expect(template.greeting.trim().length).toBeGreaterThan(0);
      expect(template.persona).toContain("You are");
    }
  });
});
