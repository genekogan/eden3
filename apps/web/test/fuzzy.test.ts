import { describe, expect, it } from "vitest";

import { fuzzyFilter, fuzzyScore } from "@/lib/fuzzy";
import { isValidAgentUsername } from "@/lib/last-agent";

describe("fuzzyScore", () => {
  it("rejects non-subsequences", () => {
    expect(fuzzyScore("xyz", "gateway")).toBeNull();
    expect(fuzzyScore("gateways", "gateway")).toBeNull(); // longer than target
  });

  it("matches subsequences case-insensitively", () => {
    expect(fuzzyScore("gtw", "Gateway")).not.toBeNull();
    expect(fuzzyScore("SCHED", "schedule")).not.toBeNull();
  });

  it("empty query matches everything with zero score", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("prefers word starts over mid-word scatter", () => {
    const wordStart = fuzzyScore("as", "agent settings")!;
    const scattered = fuzzyScore("as", "weasel")!;
    expect(wordStart).toBeGreaterThan(scattered);
  });

  it("prefers consecutive runs", () => {
    const run = fuzzyScore("chat", "chats")!;
    const scattered = fuzzyScore("chat", "changes at")!;
    expect(run).toBeGreaterThan(scattered);
  });

  it("prefers tighter targets when otherwise equal", () => {
    const tight = fuzzyScore("log", "Log")!;
    const loose = fuzzyScore("log", "Login history and events")!;
    expect(tight).toBeGreaterThan(loose);
  });
});

describe("fuzzyFilter", () => {
  const items = ["Chats", "Schedule", "Workspace", "Library", "Gateway", "Log", "Settings"];

  it("filters and ranks best-first", () => {
    const results = fuzzyFilter("se", items, (s) => s);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.item).toBe("Settings"); // word-start beats mid-word "se"
    expect(results.map((r) => r.item)).not.toContain("Chats");
  });

  it("returns everything on empty query", () => {
    expect(fuzzyFilter("", items, (s) => s)).toHaveLength(items.length);
  });
});

describe("isValidAgentUsername", () => {
  it("accepts handle-shaped names", () => {
    expect(isValidAgentUsername("verdelis")).toBe(true);
    expect(isValidAgentUsername("Kweku_2")).toBe(true);
    expect(isValidAgentUsername("a-b-c")).toBe(true);
  });

  it("rejects empty, undefined, and URL-hostile values", () => {
    expect(isValidAgentUsername(undefined)).toBe(false);
    expect(isValidAgentUsername(null)).toBe(false);
    expect(isValidAgentUsername("")).toBe(false);
    expect(isValidAgentUsername("../etc")).toBe(false);
    expect(isValidAgentUsername("a b")).toBe(false);
    expect(isValidAgentUsername("x".repeat(81))).toBe(false);
  });
});
