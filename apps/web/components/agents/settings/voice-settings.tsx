"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { getClerkToken } from "@/lib/clerk";
import { ResumableUploader } from "@/lib/resumable-upload";
import { useSelectedAgent } from "@/components/shell/selected-agent-context";
import { Skeleton } from "@/components/skeleton";
import {
  ButtonSpinner,
  primaryButtonClass,
  quietButtonClass,
} from "@/components/agents/form-fields";

type VoiceDelivery = {
  chat: "off" | "on_demand" | "always";
  discord: "off" | "always";
  telegram: "off" | "always";
};

type VoiceAssignment = {
  voiceId: string;
  delivery: VoiceDelivery;
  updatedAt: string;
};

type VoiceCatalogItem = {
  id: string;
  provider: string;
  model: string;
  name: string;
  language: string;
  kind: "roster" | "clone";
  preview: { available: boolean };
  pricing: { unit: "character"; usdPerUnit: number; tableVersion: string };
  capabilities: { preview: boolean; chat: boolean; discord: boolean; telegram: boolean };
};

type VoiceClone = {
  id: string;
  name: string;
  status: "pending_validation" | "quarantined" | "cloning" | "moderation" | "ready" | "failed" | "revoked" | "deleting" | "deleted";
  voiceId?: string | null;
  error?: { message?: string } | null;
};

type VoiceQuote = {
  characters: number;
  manna: number;
  costUsd: number;
  provider: string;
  model: string;
  tableVersion: string;
  expiresAt: string;
};

type VoiceClipSelection = { file: File; sha256: string };
type CloneAttempt = {
  requestFingerprint: string;
  key: string;
  uploads: Array<{ uploadId?: string; objectId?: string }>;
};

const DEFAULT_DELIVERY: VoiceDelivery = {
  chat: "on_demand",
  discord: "off",
  telegram: "off",
};
const PREVIEW_TEXT = "Hello — this is how I’ll sound when we work together.";
const CLIP_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/mpeg"]);
const MAX_CLIP_BYTES = 20 * 1024 * 1024;

async function voiceRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getClerkToken();
  const response = await fetch(`/api${path}`, {
    cache: "no-store",
    credentials: "include",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body && !(init.body instanceof Blob) ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    let message = "Voice settings are temporarily unavailable.";
    try {
      const body = (await response.json()) as { error?: { message?: unknown }; message?: unknown };
      const detail = body.error?.message ?? body.message;
      if (typeof detail === "string" && detail.trim()) message = detail.trim();
    } catch {
      // Keep infrastructure/provider response bodies out of the UI.
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function executionAudioUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const root = value as Record<string, unknown>;
  const execution = root.execution && typeof root.execution === "object"
    ? root.execution as Record<string, unknown>
    : root;
  for (const candidate of [execution.mediaUrl, execution.outputUrl, execution.url]) {
    if (typeof candidate === "string" && /^\/media\/voice\/[0-9a-f-]{36}$/.test(candidate)) return candidate;
  }
  const output = execution.output;
  if (output && typeof output === "object") {
    const url = (output as Record<string, unknown>).url;
    if (typeof url === "string" && /^\/media\/voice\/[0-9a-f-]{36}$/.test(url)) return url;
  }
  return null;
}

function statusLabel(status: VoiceClone["status"]): string {
  return ({
    pending_validation: "Checking clips",
    quarantined: "Needs attention",
    cloning: "Creating voice",
    moderation: "Reviewing voice",
    ready: "Ready",
    failed: "Failed",
    revoked: "Revoked",
    deleting: "Deleting",
    deleted: "Deleted",
  } as const)[status];
}

async function fileSha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function VoiceSettings({ username }: { username: string }) {
  const { agent, refresh } = useSelectedAgent();
  const [catalog, setCatalog] = useState<VoiceCatalogItem[] | null>(null);
  const [assignment, setAssignment] = useState<VoiceAssignment | null>(null);
  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [delivery, setDelivery] = useState<VoiceDelivery>(DEFAULT_DELIVERY);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewQuote, setPreviewQuote] = useState<{ voiceId: string; quote: VoiceQuote } | null>(null);
  const [clips, setClips] = useState<VoiceClipSelection[]>([]);
  const [cloneName, setCloneName] = useState("");
  const [consentFingerprint, setConsentFingerprint] = useState<string | null>(null);
  const [clone, setClone] = useState<VoiceClone | null>(null);
  const cloneAttempt = useRef<CloneAttempt | null>(null);
  const previewKeys = useRef(new Map<string, string>());
  const uploader = useMemo(() => new ResumableUploader({
    apiBaseUrl: "/api",
    getAuthToken: getClerkToken,
    refreshCredentials: async () => { await getClerkToken(); },
  }), []);

  const load = useCallback(async () => {
    const result = await voiceRequest<{ version: string; items: VoiceCatalogItem[] }>("/voices/catalog");
    setCatalog(result.items);
  }, []);

  useEffect(() => {
    const current = agent as (typeof agent & { voiceAssignment?: VoiceAssignment | null; voiceId?: string | null });
    const next = current?.voiceAssignment ?? null;
    setAssignment(next);
    setSelectedVoiceId(next?.voiceId ?? current?.voiceId ?? "");
    setDelivery(next?.delivery ?? DEFAULT_DELIVERY);
  }, [agent]);

  useEffect(() => {
    void load().catch((error) => setNote(error instanceof Error ? error.message : "Could not load voices."));
  }, [load]);

  const saveAssignment = async () => {
    if (!selectedVoiceId || busy) return;
    setBusy("save");
    setNote(null);
    try {
      await voiceRequest(`/agents/${encodeURIComponent(username)}/voice-assignment`, {
        method: "PUT",
        body: JSON.stringify({ voiceId: selectedVoiceId, delivery }),
      });
      setAssignment({ voiceId: selectedVoiceId, delivery, updatedAt: new Date().toISOString() });
      setNote("Voice assignment saved.");
      refresh();
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not save the voice.");
    } finally {
      setBusy(null);
    }
  };

  const clearAssignment = async () => {
    if (busy) return;
    setBusy("clear");
    setNote(null);
    try {
      await voiceRequest(`/agents/${encodeURIComponent(username)}/voice-assignment`, { method: "DELETE" });
      setAssignment(null);
      setSelectedVoiceId("");
      setDelivery(DEFAULT_DELIVERY);
      setNote("Voice assignment cleared.");
      refresh();
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not clear the voice.");
    } finally {
      setBusy(null);
    }
  };

  const quotePreview = async (voiceId: string) => {
    if (busy) return;
    setBusy(`quote:${voiceId}`);
    setNote(null);
    try {
      const quote = await voiceRequest<VoiceQuote>("/voices/quotes", {
        method: "POST",
        body: JSON.stringify({ voiceId, text: PREVIEW_TEXT, purpose: "preview" }),
      });
      setPreviewQuote({ voiceId, quote });
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not quote the preview.");
    } finally {
      setBusy(null);
    }
  };

  const preview = async (voiceId: string) => {
    if (busy) return;
    setBusy(`preview:${voiceId}`);
    setNote(null);
    setPreviewUrl(null);
    try {
      const idempotencyKey = previewKeys.current.get(voiceId) ?? crypto.randomUUID();
      previewKeys.current.set(voiceId, idempotencyKey);
      const result = await voiceRequest<unknown>("/voices/previews", {
        method: "POST",
        body: JSON.stringify({ voiceId, text: PREVIEW_TEXT, idempotencyKey }),
      });
      const url = executionAudioUrl(result);
      if (!url) throw new Error("The preview completed without playable audio.");
      setPreviewUrl(url);
      setPreviewQuote(null);
      previewKeys.current.delete(voiceId);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not create the preview.");
    } finally {
      setBusy(null);
    }
  };

  const changeClone = async (voice: VoiceCatalogItem, action: "revoke" | "delete") => {
    if (busy || !voice.id.startsWith("clone:")) return;
    setBusy(`${action}:${voice.id}`);
    setNote(null);
    const cloneId = voice.id.slice("clone:".length);
    try {
      await voiceRequest(`/voices/clones/${encodeURIComponent(cloneId)}${action === "revoke" ? "/revoke" : ""}`, {
        method: action === "revoke" ? "POST" : "DELETE",
      });
      if (selectedVoiceId === voice.id) {
        setAssignment(null);
        setSelectedVoiceId("");
        setDelivery(DEFAULT_DELIVERY);
      }
      await load();
      setNote(action === "revoke" ? "Custom voice revoked and removed from agents." : "Custom voice deletion started.");
      refresh();
    } catch (error) {
      setNote(error instanceof Error ? error.message : `Could not ${action} the custom voice.`);
    } finally {
      setBusy(null);
    }
  };

  const chooseClips = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(event.target.files ?? [])].slice(0, 5);
    event.target.value = "";
    const problem = chosen.find((file) => !CLIP_TYPES.has(file.type) || file.size <= 0 || file.size > MAX_CLIP_BYTES);
    if (problem) {
      setNote(`${problem.name}: use a non-empty WAV or MP3 file up to 20 MiB.`);
      return;
    }
    setBusy("hashing");
    setNote(null);
    try {
      const selected = [] as VoiceClipSelection[];
      for (const file of chosen) selected.push({ file, sha256: await fileSha256(file) });
      setClips(selected);
      setConsentFingerprint(null);
      cloneAttempt.current = null;
    } catch {
      setNote("Eden could not verify those voice clips.");
    } finally {
      setBusy(null);
    }
  };

  const cloneRequestFingerprint = `${cloneName.trim()}\n${clips.map((clip) => clip.sha256).join("\n")}`;
  const consented = Boolean(cloneRequestFingerprint && consentFingerprint === cloneRequestFingerprint);

  const createClone = async () => {
    if (busy || !consented || !cloneName.trim() || clips.length < 1) return;
    setBusy("clone");
    setNote(null);
    try {
      let attempt = cloneAttempt.current;
      if (!attempt || attempt.requestFingerprint !== cloneRequestFingerprint) {
        attempt = {
          requestFingerprint: cloneRequestFingerprint,
          key: crypto.randomUUID(),
          uploads: clips.map(() => ({})),
        };
        cloneAttempt.current = attempt;
      }
      const uploaded = [] as string[];
      for (const [index, clip] of clips.entries()) {
        const slot = attempt.uploads[index] ?? {};
        attempt.uploads[index] = slot;
        if (!slot.objectId) {
          const result = await uploader.uploadFile(clip.file, {
            purpose: "voice-clip",
            uploadId: slot.uploadId,
            onSession: ({ uploadId }) => { slot.uploadId = uploadId; },
          });
          slot.objectId = result.objectId;
        }
        uploaded.push(slot.objectId);
      }
      await voiceRequest("/voices/clones/quote", {
        method: "POST",
        body: JSON.stringify({ clipObjectIds: uploaded }),
      });
      const result = await voiceRequest<{ clone: VoiceClone }>("/voices/clones", {
        method: "POST",
        body: JSON.stringify({
          name: cloneName.trim(),
          clipObjectIds: uploaded,
          idempotencyKey: attempt.key,
          consent: { version: "voice-clone-consent-v1", attested: true },
        }),
      });
      setClone(result.clone);
      setClips([]);
      setConsentFingerprint(null);
      cloneAttempt.current = null;
      setNote("Your voice sample is being validated privately.");
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not create the custom voice.");
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!clone || !["pending_validation", "cloning", "moderation"].includes(clone.status)) return;
    const timer = setInterval(() => {
      void voiceRequest<VoiceClone>(`/voices/clones/${encodeURIComponent(clone.id)}`)
        .then((next) => {
          setClone(next);
          if (next.status === "ready") void load();
        })
        .catch(() => undefined);
    }, 2_000);
    return () => clearInterval(timer);
  }, [clone, load]);

  if (!catalog) {
    return <div className="space-y-3" aria-busy><Skeleton className="h-28" /><Skeleton className="h-28" /></div>;
  }

  const dirty = selectedVoiceId !== (assignment?.voiceId ?? "") || JSON.stringify(delivery) !== JSON.stringify(assignment?.delivery ?? DEFAULT_DELIVERY);

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-medium text-foreground">Choose a voice</h2>
          <p className="mt-1 text-sm text-muted">Preview a voice before assigning it. Generating audio always shows its manna cost first.</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {catalog.map((voice) => {
            const selected = selectedVoiceId === voice.id;
            return (
              <div key={voice.id} className={`rounded-xl border p-4 ${selected ? "border-accent bg-accent/[0.05]" : "border-edge bg-surface"}`}>
                <div className="flex items-start justify-between gap-3">
                  <button type="button" onClick={() => setSelectedVoiceId(voice.id)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-medium text-foreground">{voice.name}</span>
                    <span className="mt-0.5 block text-xs text-faint">{voice.language} · {voice.kind === "clone" ? "Your custom voice" : voice.provider}</span>
                  </button>
                  {voice.preview.available ? (
                    <button type="button" onClick={() => void quotePreview(voice.id)} disabled={busy !== null} className={quietButtonClass}>
                      {busy === `quote:${voice.id}` ? "Quoting…" : "Preview"}
                    </button>
                  ) : null}
                </div>
                {voice.kind === "clone" ? (
                  <div className="mt-3 flex justify-end gap-2 border-t border-edge pt-3">
                    <button type="button" onClick={() => void changeClone(voice, "revoke")} disabled={busy !== null} className={quietButtonClass}>Revoke</button>
                    <button type="button" onClick={() => void changeClone(voice, "delete")} disabled={busy !== null} className="rounded-lg px-3 py-2 text-xs text-danger-soft hover:bg-danger/[0.05]">Delete</button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {previewQuote ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-surface p-3 text-sm">
            <span className="text-muted">This preview costs <strong className="text-foreground">{previewQuote.quote.manna} manna</strong>.</span>
            <div className="flex gap-2">
              <button type="button" onClick={() => setPreviewQuote(null)} className={quietButtonClass}>Cancel</button>
              <button type="button" onClick={() => void preview(previewQuote.voiceId)} disabled={busy !== null} className={primaryButtonClass}>
                {busy === `preview:${previewQuote.voiceId}` ? <ButtonSpinner /> : null}{busy === `preview:${previewQuote.voiceId}` ? "Creating…" : "Create preview"}
              </button>
            </div>
          </div>
        ) : null}
        {previewUrl ? <audio controls autoPlay src={previewUrl} className="w-full" aria-label="Voice preview" /> : null}
      </section>

      <section className="space-y-3 border-t border-edge pt-6">
        <div>
          <h2 className="text-base font-medium text-foreground">When to speak</h2>
          <p className="mt-1 text-sm text-muted">Text remains the default. You can request a voice note in chat or let the agent speak automatically in selected channels.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-xs text-muted">Chat
            <select value={delivery.chat} onChange={(event) => setDelivery((value) => ({ ...value, chat: event.target.value as VoiceDelivery["chat"] }))} className="block w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-foreground">
              <option value="off">Off</option><option value="on_demand">On request</option><option value="always">Always</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-muted">Discord
            <select value={delivery.discord} onChange={(event) => setDelivery((value) => ({ ...value, discord: event.target.value as VoiceDelivery["discord"] }))} className="block w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-foreground">
              <option value="off">Off</option><option value="always">Always</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-muted">Telegram
            <select value={delivery.telegram} onChange={(event) => setDelivery((value) => ({ ...value, telegram: event.target.value as VoiceDelivery["telegram"] }))} className="block w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-foreground">
              <option value="off">Off</option><option value="always">Always</option>
            </select>
          </label>
        </div>
        <div className="flex justify-end gap-2">
          {assignment ? <button type="button" onClick={() => void clearAssignment()} disabled={busy !== null} className={quietButtonClass}>Remove voice</button> : null}
          <button type="button" onClick={() => void saveAssignment()} disabled={!selectedVoiceId || !dirty || busy !== null} className={primaryButtonClass}>
            {busy === "save" ? <ButtonSpinner /> : null}{busy === "save" ? "Saving…" : "Save voice"}
          </button>
        </div>
      </section>

      <section className="space-y-4 border-t border-edge pt-6">
        <div>
          <h2 className="text-base font-medium text-foreground">Create a custom voice</h2>
          <p className="mt-1 text-sm text-muted">Use 5–30 seconds of clear speech you own or have permission to clone. Clips stay private and are deleted with the custom voice.</p>
        </div>
        <label className="block space-y-1 text-xs text-muted">Voice name
          <input value={cloneName} onChange={(event) => { setCloneName(event.target.value); setConsentFingerprint(null); cloneAttempt.current = null; }} maxLength={80} placeholder="Warm narrator" className="block w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-foreground" />
        </label>
        <label className="block rounded-xl border border-dashed border-edge bg-surface px-4 py-5 text-center text-sm text-muted">
          <span className="font-medium text-foreground">Choose 1–5 WAV or MP3 clips</span>
          <span className="mt-1 block text-xs text-faint">20 MiB each; 5–30 seconds total</span>
          <input type="file" multiple accept="audio/wav,audio/mpeg" onChange={(event) => void chooseClips(event)} className="sr-only" />
        </label>
        {busy === "hashing" ? <p className="text-xs text-muted">Verifying clips…</p> : null}
        {clips.length ? <ul className="space-y-1 text-xs text-muted">{clips.map(({ file, sha256 }) => <li key={sha256} className="truncate">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MiB · {sha256.slice(0, 10)}</li>)}</ul> : null}
        <label className="flex items-start gap-2 text-sm text-muted">
          <input type="checkbox" checked={consented} onChange={(event) => setConsentFingerprint(event.target.checked ? cloneRequestFingerprint : null)} className="mt-1" />
          <span>I own this voice or have explicit permission to clone it, and I consent to creating this custom voice.</span>
        </label>
        <button type="button" onClick={() => void createClone()} disabled={busy !== null || !consented || !cloneName.trim() || clips.length < 1} className={primaryButtonClass}>
          {busy === "clone" ? <ButtonSpinner /> : null}{busy === "clone" ? "Uploading securely…" : "Create custom voice"}
        </button>
        {clone ? (
          <div role="status" className="rounded-xl border border-edge bg-surface p-4 text-sm">
            <div className="flex items-center justify-between gap-3"><span className="font-medium text-foreground">{clone.name}</span><span className="text-xs text-muted">{statusLabel(clone.status)}</span></div>
            {clone.error?.message ? <p className="mt-2 text-xs text-danger-soft">{clone.error.message}</p> : null}
          </div>
        ) : null}
      </section>

      {note ? <p role="status" className="rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-muted">{note}</p> : null}
    </div>
  );
}
