import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { executionAudioUrl } from "../components/agents/settings/voice-settings";

const voiceSource = readFileSync(
  new URL("../components/agents/settings/voice-settings.tsx", import.meta.url),
  "utf8",
);
const identitySource = readFileSync(
  new URL("../components/agents/settings/identity-form.tsx", import.meta.url),
  "utf8",
);

describe("voice settings", () => {
  it("accepts only Eden-owned preview media paths", () => {
    expect(executionAudioUrl({ execution: { mediaUrl: "/media/voice-preview.mp3" } })).toBe(
      "/media/voice-preview.mp3",
    );
    expect(executionAudioUrl({ execution: { output: { url: "/media/voice-note.ogg" } } })).toBe(
      "/media/voice-note.ogg",
    );
    expect(executionAudioUrl({ execution: { mediaUrl: "https://tracker.example/audio.mp3" } })).toBeNull();
    expect(executionAudioUrl({ execution: { mediaUrl: "data:audio/mpeg;base64,AAAA" } })).toBeNull();
  });

  it("binds quotes, consent, private resumable clips, assignment, revoke, and deletion", () => {
    for (const contract of [
      'voiceRequest<VoiceQuote>("/voices/quotes"',
      'voiceRequest<unknown>("/voices/previews"',
      'purpose: "voice-clip"',
      'version: "voice-clone-consent-v1"',
      'attested: true',
      '/voice-assignment`, {',
      '"/revoke"',
      'method: action === "revoke" ? "POST" : "DELETE"',
    ]) {
      expect(voiceSource, contract).toContain(contract);
    }
    expect(voiceSource).not.toContain("ELEVENLABS_API_KEY");
    expect(voiceSource).not.toContain("CARTESIA_API_KEY");
    expect(voiceSource).not.toContain("DEEPINFRA_API_KEY");
    expect(voiceSource).toContain("previewKeys.current.get(voiceId)");
    expect(voiceSource).toContain("uploadId: slot.uploadId");
    expect(voiceSource).toContain("idempotencyKey: attempt.key");
    expect(voiceSource).toContain("setConsentFingerprint(null)");
    expect(voiceSource).toContain("consentFingerprint === cloneRequestFingerprint");
    expect(voiceSource).toContain("voiceRequest<VoiceClone>");
    expect(voiceSource).toContain(
      "voiceRequest<VoiceClone>(`/voices/clones/${encodeURIComponent(clone.id)}`)",
    );
  });

  it("removes the ambiguous legacy free-text voice field from Identity", () => {
    expect(identitySource).not.toContain('id="identity-voice"');
    expect(identitySource).not.toContain('setField("voice")');
  });
});
