import { afterEach, describe, expect, it, vi } from "vitest";

import {
  absoluteShareUrl,
  initialSessionShareDialogState,
  sessionShareDialogReducer,
} from "../components/chat/session-share-model";
import { isPublicSharePath } from "../lib/public-routes";
import { api, ApiError } from "../lib/api";

const SHARE = {
  id: "00000000-0000-4000-8000-000000000101",
  sessionId: "00000000-0000-4000-8000-000000000001",
  mode: "snapshot" as const,
  title: "Launch excerpt",
  createdAt: "2026-08-08T10:00:00.000Z",
  revokedAt: null,
};

describe("session share journey model", () => {
  afterEach(() => vi.unstubAllGlobals());

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

  it("never includes the raw share token in an API error message", async () => {
    const token = "s".repeat(43);
    let requestInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestInit = init;
        return new Response(JSON.stringify({ message: `synthetic failure ${token}` }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const error = await api.shares.public(token).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as Error).message).not.toContain(token);
    expect((error as Error).message).toContain("[redacted]");
    expect(JSON.stringify((error as ApiError).body) ?? "").not.toContain(token);
    expect(requestInit?.cache).toBe("no-store");
  });
});
