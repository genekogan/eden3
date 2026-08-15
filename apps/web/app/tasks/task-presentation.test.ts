import { describe, expect, it } from "vitest";
import { friendlyTaskIssue } from "./task-presentation";

describe("friendlyTaskIssue", () => {
  it("explains rolling automation protection without exposing internals", () => {
    const issue = friendlyTaskIssue(
      "auto-paused after automation budget refusal: automation rolling manna cap exceeded: scope 53442cb1-25d4-4820-8e3b-3c650486ccad spent 61 in the last 3600000ms, requested 24 more, cap is 80",
    );
    expect(issue).toMatchObject({
      kind: "budget",
      title: "Paused to protect your manna",
      spent: 61,
      requested: 24,
      cap: 80,
    });
    expect(issue?.detail).toContain("61 of its 80-manna automation allowance");
    expect(issue?.detail).toContain("returns gradually");
    expect(JSON.stringify(issue)).not.toContain("53442cb1");
    expect(JSON.stringify(issue)).not.toContain("3600000ms");
    expect(JSON.stringify(issue)).not.toContain("rolling manna cap");
  });

  it("never reflects an unknown internal error", () => {
    const issue = friendlyTaskIssue("postgres 42501 for account secret-id");
    expect(issue?.title).toBe("The latest run did not complete");
    expect(JSON.stringify(issue)).not.toContain("42501");
    expect(JSON.stringify(issue)).not.toContain("secret-id");
  });
});
