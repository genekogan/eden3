import { describe, expect, it } from "vitest";

import { AGENT_TEMPLATES } from "../components/agents/agent-create-form";
import { normalizeUsername, usernameError } from "../components/agents/agent-utils";
import {
  BOOTSTRAP_FILE_NAMES,
  findPersonaBanalities,
  lintPersonaDoctrine,
  MAX_BOOTSTRAP_FILE_CHARS,
} from "@eden3/shared";
import { renderedDoctrine } from "./persona-doctrine-fixture";

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
      expect(template.persona.length).toBeLessThanOrEqual(MAX_BOOTSTRAP_FILE_CHARS);
      expect(findPersonaBanalities(template.persona)).toEqual([]);
      const files = renderedDoctrine(template.persona);
      expect(Object.keys(files).sort()).toEqual([...BOOTSTRAP_FILE_NAMES].sort());
      expect(lintPersonaDoctrine(files)).toEqual([]);
    }
  });
});
