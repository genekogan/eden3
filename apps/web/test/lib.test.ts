import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeSseEvent, encodeSseComment, extractSseData } from "@eden3/shared";
import type { SessionEvent } from "@eden3/shared";
import {
  createSseFrameSplitter,
  decodeSessionEventData,
  sessionEventsUrl,
  streamSseBody,
} from "../lib/sse";
import { api, toPaginated } from "../lib/api";
import { formatManna, formatRelativeTime } from "../lib/format";
import { decodeBlurhash } from "../lib/blurhash";

const SESSION_ID = "6c1f5b7e-3d2a-4e8b-9f10-2a3b4c5d6e7f";
const TURN_ID = "0f9e8d7c-6b5a-4433-a221-100f0e0d0c0b";

describe("lib/sse decode", () => {
  it("decodes a shared-encoded frame back into the typed event", () => {
    const event: SessionEvent = { type: "token", turnId: TURN_ID, delta: "he\nllo" };
    // api side: encodeSseEvent -> frame; browser side: EventSource de-frames
    // (extractSseData stands in for it here) -> decodeSessionEventData.
    const payload = extractSseData(encodeSseEvent(event));
    expect(payload).not.toBeNull();
    expect(decodeSessionEventData(payload)).toEqual(event);
  });

  it("round-trips every event type in the lifecycle", () => {
    const events: SessionEvent[] = [
      { type: "turn.started", sessionId: SESSION_ID, turnId: TURN_ID },
      { type: "token", turnId: TURN_ID, delta: "" },
      { type: "turn.completed", turnId: TURN_ID, messageId: SESSION_ID },
      { type: "media.pending", sessionId: SESSION_ID, tool: "image_generate" },
      {
        type: "media.attached",
        sessionId: SESSION_ID,
        messageId: TURN_ID,
        url: "/media/ab/cd.png",
        mime: "image/png",
        creationId: SESSION_ID,
      },
      { type: "manna.updated", accountId: SESSION_ID, balance: 42.5 },
      { type: "error", code: "gateway_error", message: "boom" },
    ];
    for (const event of events) {
      const payload = extractSseData(encodeSseEvent(event));
      expect(decodeSessionEventData(payload)).toEqual(event);
    }
  });

  it("returns null for junk, comments, and unknown event types", () => {
    expect(decodeSessionEventData("not json")).toBeNull();
    expect(decodeSessionEventData('{"type":"nope"}')).toBeNull();
    expect(decodeSessionEventData('{"delta":"x"}')).toBeNull();
    expect(decodeSessionEventData(undefined)).toBeNull();
    expect(decodeSessionEventData(extractSseData(": ping\n\n"))).toBeNull();
  });

  it("builds the per-session events URL with escaping", () => {
    expect(sessionEventsUrl("abc/../x")).toBe(
      "/api/sessions/abc%2F..%2Fx/events",
    );
  });
});

describe("lib/sse createSseFrameSplitter", () => {
  it("splits whole frames and buffers partial ones across pushes", () => {
    const splitter = createSseFrameSplitter();
    expect(splitter.push('data: {"a":1}\n\nda')).toEqual(['data: {"a":1}']);
    expect(splitter.push('ta: {"b":2}\n')).toEqual([]);
    expect(splitter.push("\n")).toEqual(['data: {"b":2}']);
    expect(splitter.flush()).toBeNull();
  });

  it("handles CRLF delimiters, including a CRLF split across chunks", () => {
    const splitter = createSseFrameSplitter();
    expect(splitter.push("data: x\r\n\r")).toEqual([]);
    expect(splitter.push("\ndata: y\r\n\r\n")).toEqual(["data: x", "data: y"]);
  });

  it("drops heartbeat-only whitespace and flushes an unterminated tail", () => {
    const splitter = createSseFrameSplitter();
    expect(splitter.push("\n\n\n\ndata: tail")).toEqual([]);
    expect(splitter.flush()).toBe("data: tail");
    expect(splitter.flush()).toBeNull();
  });
});

describe("lib/sse streamSseBody", () => {
  function bodyFromText(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) {
          controller.enqueue(bytes.slice(i, i + chunkSize));
        }
        controller.close();
      },
    });
  }

  it("yields typed events across arbitrary chunk boundaries", async () => {
    const events: SessionEvent[] = [
      { type: "turn.started", sessionId: SESSION_ID, turnId: TURN_ID },
      { type: "token", turnId: TURN_ID, delta: "hello " },
      { type: "token", turnId: TURN_ID, delta: "🌱 world" },
      { type: "turn.completed", turnId: TURN_ID, messageId: SESSION_ID },
    ];
    const wire =
      encodeSseComment("ping") +
      events.map((e) => encodeSseEvent(e)).join(encodeSseComment()) ;
    const seen: SessionEvent[] = [];
    for await (const event of streamSseBody(bodyFromText(wire, 3))) {
      seen.push(event);
    }
    expect(seen).toEqual(events);
  });

  it("reports unknown data frames and skips them", async () => {
    const wire =
      'data: {"type":"mystery"}\n\n' +
      encodeSseEvent({ type: "manna.updated", accountId: SESSION_ID, balance: 5 });
    const unknown: string[] = [];
    const seen: SessionEvent[] = [];
    for await (const event of streamSseBody(bodyFromText(wire), {
      onUnknownFrame: (frame) => unknown.push(frame),
    })) {
      seen.push(event);
    }
    expect(seen).toEqual([
      { type: "manna.updated", accountId: SESSION_ID, balance: 5 },
    ]);
    expect(unknown).toEqual(['data: {"type":"mystery"}']);
  });
});

describe("lib/api toPaginated", () => {
  it("passes through the canonical {items, nextCursor} page", () => {
    expect(toPaginated<number>({ items: [1, 2], nextCursor: "c2" })).toEqual({
      items: [1, 2],
      nextCursor: "c2",
    });
  });

  it("accepts contract-named arrays via key hints", () => {
    expect(
      toPaginated<string>({ sessions: ["s1"], nextCursor: "n" }, "sessions"),
    ).toEqual({ items: ["s1"], nextCursor: "n" });
    expect(toPaginated<string>({ agents: ["a"] }, "agents")).toEqual({
      items: ["a"],
      nextCursor: null,
    });
    expect(
      toPaginated<string>({ creations: [], nextCursor: null }, "creations"),
    ).toEqual({ items: [], nextCursor: null });
  });

  it("normalizes bare arrays and terminal pages", () => {
    expect(toPaginated<number>([1])).toEqual({ items: [1], nextCursor: null });
    expect(toPaginated<number>({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("degrades to an empty page on junk", () => {
    expect(toPaginated(undefined)).toEqual({ items: [], nextCursor: null });
    expect(toPaginated({ nope: true }, "sessions")).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});

describe("lib/api browser transport", () => {
  const originalPublicApiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN;

  afterEach(() => {
    if (originalPublicApiOrigin === undefined) {
      delete process.env.NEXT_PUBLIC_API_ORIGIN;
    } else {
      process.env.NEXT_PUBLIC_API_ORIGIN = originalPublicApiOrigin;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends long-running Studio generation directly to the API origin", async () => {
    process.env.NEXT_PUBLIC_API_ORIGIN = "http://127.0.0.1:4301/";
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          creationId: "creation-1",
          url: "http://127.0.0.1:4301/media/video.mp4",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const result = await api.studio.generate(
      { tool: "video_generate", args: { prompt: "teal cube", duration: 2 } },
      { signal: controller.signal },
    );

    expect(result.creationId).toBe("creation-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(init).toBeDefined();
    const requestInit = init as RequestInit;
    expect(url).toBe("http://127.0.0.1:4301/studio/generate");
    expect(requestInit).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "include",
      signal: controller.signal,
    });
    expect(JSON.parse(String(requestInit.body))).toEqual({
      tool: "video_generate",
      args: { prompt: "teal cube", duration: 2 },
    });
  });

  it("keeps ordinary browser API calls on the same-origin rewrite", async () => {
    process.env.NEXT_PUBLIC_API_ORIGIN = "http://127.0.0.1:4301";
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          quote: { tool: "image_generate", manna: 181 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.studio.quote({ tool: "image_generate", args: { prompt: "cactus" } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(init).toBeDefined();
    expect(url).toBe("/api/studio/quote");
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
  });

  it("normalizes the auth settings payload", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          user: {
            id: "acct-1",
            username: "gene",
            type: "user",
            userImage: null,
            isAdmin: true,
          },
          manna: { balance: 12, subscriptionBalance: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.auth.me()).resolves.toEqual({
      user: {
        id: "acct-1",
        username: "gene",
        type: "user",
        userImage: null,
        isAdmin: true,
      },
      manna: { balance: 12, subscriptionBalance: 3 },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/me");
    expect(init).toMatchObject({ credentials: "include" });
  });

  it("normalizes the billing subscription payload without Stripe identifiers", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          subscription: {
            status: "active",
            tier: "pro",
            monthlyManna: 9000,
            currentPeriodEnd: "2026-08-01T00:00:00.000Z",
            cancelAtPeriodEnd: false,
            updatedAt: "2026-07-07T00:00:00.000Z",
            stripeSubscriptionId: "sub_hidden",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.billing.subscription()).resolves.toEqual({
      status: "active",
      tier: "pro",
      monthlyManna: 9000,
      currentPeriodEnd: "2026-08-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      updatedAt: "2026-07-07T00:00:00.000Z",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/billing/subscription");
    expect(init).toMatchObject({ credentials: "include" });
  });
});

describe("lib/format", () => {
  // Local-time noon keeps calendar-date expectations stable across TZs.
  const NOW = new Date(2026, 6, 2, 12, 0, 0).getTime();

  it("formats relative past and future times", () => {
    expect(formatRelativeTime(NOW - 10_000, NOW)).toBe("just now");
    expect(formatRelativeTime(NOW - 4 * 60_000, NOW)).toBe("4m ago");
    expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(formatRelativeTime(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
    expect(formatRelativeTime(NOW + 5 * 60_000, NOW)).toBe("in 5m");
    expect(formatRelativeTime("garbage", NOW)).toBe("—");
  });

  it("falls back to calendar dates beyond ~4 weeks", () => {
    expect(formatRelativeTime(NOW - 60 * 86_400_000, NOW)).toBe("May 3");
    expect(formatRelativeTime(NOW - 400 * 86_400_000, NOW)).toBe("May 28, 2025");
  });

  it("formats manna compactly, preserving sign", () => {
    expect(formatManna(0)).toBe("0");
    expect(formatManna(842)).toBe("842");
    expect(formatManna(1204)).toBe("1,204");
    expect(formatManna(12_400)).toBe("12.4k");
    expect(formatManna(3_100_000)).toBe("3.1M");
    expect(formatManna(-250)).toBe("-250");
    expect(formatManna(2.5)).toBe("2.5");
    expect(formatManna(null)).toBe("—");
    expect(formatManna(Number.NaN)).toBe("—");
  });
});

describe("lib/blurhash", () => {
  it("decodes a valid hash into RGBA pixels", () => {
    const pixels = decodeBlurhash("LEHV6nWB2yk8pyo0adR*.7kCMdnj", 8, 8);
    expect(pixels).not.toBeNull();
    expect(pixels).toHaveLength(8 * 8 * 4);
    // Opaque alpha everywhere; channels inside byte range by construction.
    for (let i = 3; i < pixels!.length; i += 4) expect(pixels![i]).toBe(255);
  });

  it("returns null on malformed input instead of throwing", () => {
    expect(decodeBlurhash(null)).toBeNull();
    expect(decodeBlurhash("")).toBeNull();
    expect(decodeBlurhash("LEHV6n")).toBeNull(); // truncated for its size flag
    expect(decodeBlurhash('L"""""""""""""""""""""""""""')).toBeNull();
  });
});
