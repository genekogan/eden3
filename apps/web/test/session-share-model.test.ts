import { describe, expect, it } from "vitest";

import {
  absoluteShareUrl,
  initialSessionShareDialogState,
  sessionShareDialogReducer,
} from "../components/chat/session-share-model";
import { isPublicSharePath } from "../lib/public-routes";

const SHARE = {
  id: "00000000-0000-4000-8000-000000000101",
  sessionId: "00000000-0000-4000-8000-000000000001",
  mode: "snapshot" as const,
  title: "Launch excerpt",
  createdAt: "2026-08-08T10:00:00.000Z",
  revokedAt: null,
};

describe("session share journey model", () => {
  it("moves create → copyable public route → terminal revoke without exposing cockpit chrome", () => {
    let state = sessionShareDialogReducer(initialSessionShareDialogState, { type: "open" });
    state = sessionShareDialogReducer(state, { type: "title", title: "Launch excerpt" });
    state = sessionShareDialogReducer(state, { type: "create/start" });
    expect(state.pending).toBe("create");

    const publicUrl = absoluteShareUrl(
      `/share/${"a".repeat(43)}`,
      "https://eden.example/app",
    );
    state = sessionShareDialogReducer(state, {
      type: "create/success",
      share: SHARE,
      publicUrl,
    });
    expect(state.publicUrl).toBe(`https://eden.example/share/${"a".repeat(43)}`);
    expect(isPublicSharePath(new URL(state.publicUrl!).pathname)).toBe(true);
    expect(isPublicSharePath("/agents/ada/chats")).toBe(false);

    state = sessionShareDialogReducer(state, { type: "revoke/start" });
    state = sessionShareDialogReducer(state, {
      type: "revoke/success",
      share: { ...SHARE, revokedAt: "2026-08-08T10:01:00.000Z" },
    });
    expect(state.publicUrl).toBeNull();
    expect(state.items[0]?.revokedAt).toBe("2026-08-08T10:01:00.000Z");
  });
});
