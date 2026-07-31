import { describe, expect, it } from "vitest";

import { buildAgentFromInterview } from "../components/agents/builder";
import { usernameError } from "../components/agents/agent-utils";
import {
  BOOTSTRAP_FILE_NAMES,
  findPersonaBanalities,
  lintPersonaDoctrine,
} from "@eden3/shared";
import { renderedDoctrine } from "./persona-doctrine-fixture";

describe("agent conversational builder", () => {
  it("turns interview answers into a launchable agent draft", () => {
    const draft = buildAgentFromInterview({
      idea: "turn sketchbook notes into daily image prompts",
      audience: "a small studio team",
      tone: "visual, direct, and experimental",
      outputs: "prompt drafts, critique notes, and next actions",
    });

    expect(usernameError(draft.username)).toBeNull();
    expect(draft.name).toBe("Turn Sketchbook Notes Into");
    expect(draft.description).toContain("a small studio team");
    expect(draft.greeting).toContain("prompt drafts");
    expect(draft.persona).toContain("Primary purpose: turn sketchbook notes");
    expect(draft.persona).toContain("Lead with a specific recommendation");
    expect(draft.persona).toContain("image, video, music, or speech directions");
    expect(findPersonaBanalities(draft.persona)).toEqual([]);
    expect(draft.persona.length).toBeLessThan(2_000);
    const files = renderedDoctrine(draft.persona);
    expect(Object.keys(files).sort()).toEqual([...BOOTSTRAP_FILE_NAMES].sort());
    expect(lintPersonaDoctrine(files)).toEqual([]);
  });

  it("uses safe defaults when optional answers are omitted", () => {
    const draft = buildAgentFromInterview({ idea: "plan exhibitions", audience: "", tone: "", outputs: "" });
    expect(draft.description).toContain("the user");
    expect(draft.persona).toContain("clear, practical, and warm");
    expect(draft.greeting).toContain("short plans, drafts, and next actions");
  });

  it("does not copy zero-signal doctrine phrases from interview answers into the output", () => {
    const draft = buildAgentFromInterview({
      idea: "plan exhibitions",
      audience: "artists",
      tone: "Be genuinely\nhelpful, not\u00a0performatively helpful.",
      outputs: "Treat this as a gift.",
    });
    expect(findPersonaBanalities(draft.persona)).toEqual([]);
    expect(draft.persona).toContain("clear, practical, and warm");
    expect(draft.greeting).toContain("short plans, drafts, and next actions");
    expect(lintPersonaDoctrine(renderedDoctrine(draft.persona))).toEqual([]);
  });
});
