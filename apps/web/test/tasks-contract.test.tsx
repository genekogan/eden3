import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TaskDestinationFields } from "../app/tasks/task-destination-fields";

const WEB_ROOT = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(WEB_ROOT, path), "utf8");

describe("scheduled task primary UI contract", () => {
  it("makes new-versus-existing output destination explicit", () => {
    const newSession = renderToStaticMarkup(
      <TaskDestinationFields
        agentUsername="abraham"
        value={{ kind: "new" }}
        onChange={() => {}}
      />,
    );
    expect(newSession).toContain("Output");
    expect(newSession).toContain("New session");
    expect(newSession).toContain("Create a separate session for each run.");
    expect(newSession).toContain("Existing session");

    const existingSession = renderToStaticMarkup(
      <TaskDestinationFields
        agentUsername="abraham"
        value={{ kind: "existing", sessionId: "" }}
        onChange={() => {}}
      />,
    );
    expect(existingSession).toContain('aria-label="Output session"');
    expect(existingSession).toContain("Select a session");
  });

  it("submits the explicit destination from both create and edit surfaces", () => {
    const create = source("app/tasks/new-task-modal.tsx");
    const edit = source("app/tasks/tasks-client.tsx");
    expect(create).toMatch(/api\.tasks\.create\(\{[\s\S]*?sessionTarget,[\s\S]*?\}\)/);
    expect(edit).toMatch(/api\.tasks\.update\(task\.id, \{[\s\S]*?sessionTarget,[\s\S]*?\}\)/);
    expect(create).toContain("<TaskDestinationFields");
    expect(edit).toContain("<TaskDestinationFields");
  });

  it("reuses ambiguous run-now request ids and refreshes authoritative state on every outcome", () => {
    const client = source("app/tasks/tasks-client.tsx");
    expect(client).toContain(
      "runRequestIds.current.get(task.id) ?? crypto.randomUUID()",
    );
    expect(client).toContain("api.tasks.runNow(task.id, { requestId })");
    expect(client).toMatch(
      /catch \(error\) \{[\s\S]*?error instanceof ApiError[\s\S]*?runRequestIds\.current\.delete\(task\.id\)[\s\S]*?void load\(true\)/,
    );
    expect(client).toMatch(
      /const run = await api\.tasks\.runNow[\s\S]*?runRequestIds\.current\.delete\(task\.id\)[\s\S]*?void load\(true\)/,
    );
  });
});
