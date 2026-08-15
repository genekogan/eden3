import { costFromParams, mannaForEstimate } from './metering';

export const VOICE_CATALOG_VERSION = '2026-08-15.kokoro-v1';
export const DEFAULT_VOICE_ID = 'deepinfra:kokoro:af_bella:v1';

export interface VoiceCatalogEntry {
  id: string;
  provider: 'deepinfra' | 'cartesia' | 'elevenlabs';
  model: string;
  providerVoiceId: string;
  name: string;
  locale: string;
  gender: 'feminine' | 'masculine' | 'neutral';
  previewable: boolean;
  clonable: boolean;
}

/** Stable IDs are Eden-owned; provider names may change without breaking assignments. */
export const VOICE_CATALOG: readonly VoiceCatalogEntry[] = Object.freeze([
  { id: DEFAULT_VOICE_ID, provider: 'deepinfra', model: 'hexgrad/Kokoro-82M', providerVoiceId: 'af_bella', name: 'Bella', locale: 'en-US', gender: 'feminine', previewable: true, clonable: false },
  { id: 'deepinfra:kokoro:af_heart:v1', provider: 'deepinfra', model: 'hexgrad/Kokoro-82M', providerVoiceId: 'af_heart', name: 'Heart', locale: 'en-US', gender: 'feminine', previewable: true, clonable: false },
  { id: 'deepinfra:kokoro:am_adam:v1', provider: 'deepinfra', model: 'hexgrad/Kokoro-82M', providerVoiceId: 'am_adam', name: 'Adam', locale: 'en-US', gender: 'masculine', previewable: true, clonable: false },
  { id: 'deepinfra:kokoro:bm_george:v1', provider: 'deepinfra', model: 'hexgrad/Kokoro-82M', providerVoiceId: 'bm_george', name: 'George', locale: 'en-GB', gender: 'masculine', previewable: true, clonable: false },
]);

export function catalogVoice(id: string): VoiceCatalogEntry | null {
  return VOICE_CATALOG.find((voice) => voice.id === id) ?? null;
}

export function quoteCatalogVoice(voiceId: string, characterCount: number) {
  const voice = catalogVoice(voiceId);
  if (!voice) return null;
  const estimate = costFromParams({
    provider: voice.provider,
    model: voice.model,
    units: { audio_character: characterCount },
  });
  return {
    voiceId,
    provider: voice.provider,
    model: voice.model,
    characterCount,
    costUsd: estimate.totalCostUsd,
    manna: mannaForEstimate(estimate),
    tableVersion: estimate.tableVersion,
    estimated: estimate.estimated,
  };
}
