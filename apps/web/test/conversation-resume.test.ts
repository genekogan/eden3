import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_PATH = resolve(
  import.meta.dirname,
  "../components/chat/conversation.tsx",
);

function resumeContract(source: string): boolean {
  const start = source.indexOf("// Session events channel");
  const end = source.indexOf("// Scroll behavior", start);
  if (start < 0 || end <= start) return false;
  const block = source.slice(start, end);

  const messageChanged = block.indexOf('event.type === "session.messages.changed"');
  const messageRefresh = block.indexOf("scheduleHistoryRefresh();", messageChanged);

  const openCallback = block.indexOf("onOpen:");
  const openCallbackEnd = block.indexOf("onConnectionError:", openCallback);
  const reconcileAfterOpen = block.indexOf("scheduleHistoryRefresh", openCallback);
  const visibilityListener = block.indexOf(
    'document.addEventListener("visibilitychange"',
    reconcileAfterOpen,
  );
  const onlineListener = block.indexOf(
    'window.addEventListener("online"',
    visibilityListener,
  );
  const pageShowListener = block.indexOf(
    'window.addEventListener("pageshow"',
    onlineListener,
  );
  const removeVisibility = block.indexOf(
    'document.removeEventListener("visibilitychange"',
    pageShowListener,
  );
  const removeOnline = block.indexOf(
    'window.removeEventListener("online"',
    removeVisibility,
  );
  const removePageShow = block.indexOf(
    'window.removeEventListener("pageshow"',
    removeOnline,
  );

  return [
    start,
    messageChanged,
    messageRefresh,
    openCallback,
    openCallbackEnd,
    reconcileAfterOpen,
    visibilityListener,
    onlineListener,
    pageShowListener,
    removeVisibility,
    removeOnline,
    removePageShow,
  ].every((index) => index >= 0) && reconcileAfterOpen < openCallbackEnd;
}

describe("conversation mobile/background resume", () => {
  it("reconciles durable history after SSE reconnect, foreground, online, and bfcache resume", () => {
    expect(resumeContract(readFileSync(SOURCE_PATH, "utf8"))).toBe(true);
  });

  it.each([
    ["channel-message reconciliation", /event\.type === "session\.messages\.changed"/],
    [
      "SSE-open reconciliation",
      /onOpen: \(\) => \{[\s\S]*?scheduleHistoryRefresh\(\);[\s\S]*?\},/,
    ],
    ["visibility resume", /document\.addEventListener\("visibilitychange"[^;]+;/],
    ["online resume", /window\.addEventListener\("online"[^;]+;/],
    ["bfcache resume", /window\.addEventListener\("pageshow"[^;]+;/],
  ])("fails when %s is removed", (_name, mutation) => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    expect(resumeContract(source.replace(mutation, ""))).toBe(false);
  });
});
