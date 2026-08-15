import { getClerkToken } from "./clerk";
import type {
  DictationRemoteSession,
  DictationTransport,
} from "./dictation-session";

const BASE_PATH = "/api/transcriptions";

async function request(path: string, init: RequestInit): Promise<Response> {
  const token = await getClerkToken();
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "include",
    ...init,
    headers: {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    let message = "Dictation is temporarily unavailable.";
    try {
      const body = (await response.json()) as {
        message?: unknown;
        error?: { message?: unknown };
      };
      const detail = body.message ?? body.error?.message;
      if (typeof detail === "string" && detail.trim()) message = detail.trim();
    } catch {
      // Never expose provider or infrastructure response bodies to the UI.
    }
    throw new Error(message);
  }
  return response;
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type TranscriptionStatus = {
  id: string;
  status: "uploading" | "queued" | "processing" | "completed" | "failed" | "expired" | "deleted";
  transcript?: string;
  error?: { message?: string };
};

export function edenDictationTransport(): DictationTransport {
  return {
    async create({ idempotencyKey, maxDurationMs }): Promise<DictationRemoteSession> {
      const response = await request(BASE_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ language: "en", maxDurationMs }),
      });
      const body = (await response.json()) as {
        id?: string;
        maxDurationMs?: number;
        limits?: { maxDurationMs?: number };
      };
      if (!body.id) throw new Error("Eden could not start dictation.");
      return {
        id: body.id,
        maxDurationSeconds:
          (body.maxDurationMs ?? body.limits?.maxDurationMs ?? maxDurationMs) / 1_000,
      };
    },

    async uploadChunk({ sessionId, index, audio, sha256 }) {
      const response = await request(
        `${BASE_PATH}/${encodeURIComponent(sessionId)}/chunks/${index}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "x-chunk-sha256": sha256,
          },
          body: audio,
        },
      );
      const body = (await response.json()) as { acknowledgedThrough?: number };
      if (!Number.isSafeInteger(body.acknowledgedThrough) || body.acknowledgedThrough! < index) {
        throw new Error("Eden did not acknowledge the recorded audio.");
      }
      return { acknowledgedThrough: body.acknowledgedThrough! };
    },

    async finalize({ sessionId, finalChunkNumber, idempotencyKey }) {
      const statusUrl = `${BASE_PATH}/${encodeURIComponent(sessionId)}`;
      await request(`${statusUrl}/finalize`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ finalChunkNumber }),
      });

      // The durable job continues server-side if this page refreshes. Polling
      // is bounded and carries no audio; recovery replays the same finalize
      // key and resumes from the authoritative server state.
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const response = await request(statusUrl, { method: "GET" });
        const status = (await response.json()) as TranscriptionStatus;
        if (status.status === "completed") return { transcript: status.transcript ?? "" };
        if (["failed", "expired", "deleted"].includes(status.status)) {
          throw new Error(status.error?.message ?? "Eden could not transcribe this recording.");
        }
        await pause(attempt < 4 ? 500 : 1_000);
      }
      throw new Error("Transcription is taking longer than expected. Eden will resume it after refresh.");
    },

    async cancel(sessionId) {
      await request(`${BASE_PATH}/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
    },
  };
}
