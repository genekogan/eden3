import { describe, expect, it } from "vitest";

import { buildAgentFromInterview } from "../components/agents/builder";
import { usernameError } from "../components/agents/agent-utils";

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
    expect(draft.persona).toContain("Default skill posture");
    expect(draft.persona).toContain("image, video, music, and speech tools");
  });

  it("uses safe defaults when optional answers are omitted", () => {
    const draft = buildAgentFromInterview({ idea: "plan exhibitions", audience: "", tone: "", outputs: "" });
    expect(draft.description).toContain("the user");
    expect(draft.persona).toContain("clear, practical, and warm");
    expect(draft.greeting).toContain("short plans, drafts, and next actions");
  });
});
