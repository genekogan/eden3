import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TaskDestinationFields } from "../app/tasks/task-destination-fields";

const WEB_ROOT = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(WEB_ROOT, path), "utf8");

describe("scheduled task primary UI contract", () => {
  it("uses schedule language and independent desktop scroll panes", () => {
    const client = source("app/tasks/tasks-client.tsx");
    const create = source("app/tasks/new-task-modal.tsx");
    expect(client).toContain('title="Schedules"');
    expect(client).toContain("New schedule");
    expect(client).toContain('aria-label="Schedules"');
    expect(client).toContain('aria-label="Schedule details"');
    expect(client).toContain("lg:flex-1 lg:overflow-y-auto lg:overscroll-contain");
    expect(client).toContain("lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain");
    expect(create).toContain("New schedule");
    expect(create).toContain("Create schedule");
  });

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

  it("presents task details, allowance, and recorded outputs without raw scheduler errors", () => {
    const client = source("app/tasks/tasks-client.tsx");
    expect(client).toContain("api.tasks.runs(taskId)");
    expect(client).toContain("Automation allowance");
    expect(client).toContain("Run history");
    expect(client).toContain("Open latest conversation");
    expect(client).toContain("friendlyTaskIssue(selectedTask?.lastError)");
    expect(client).not.toContain("title={task.lastError}");
    expect(client).not.toMatch(/>\s*\{task\.lastError\}\s*</);
  });

  it("keeps timezone on the wire while hiding IANA implementation labels", () => {
    const fields = source("app/tasks/schedule-fields.tsx");
    const schedule = source("app/tasks/schedule.ts");
    expect(fields).toContain("Times follow your system clock.");
    expect(fields).not.toContain('aria-label="Timezone"');
    expect(schedule).not.toContain(" · ${schedule.timezone}");
  });
});
