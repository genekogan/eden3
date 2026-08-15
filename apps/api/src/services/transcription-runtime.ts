import { getEnv } from '@eden3/core';

import { CartesiaTranscriptionProvider } from './cartesia-transcription-provider';
import { startBackgroundWorkerLoop, type BackgroundWorkerLoop } from './background-worker-loop';
import { PrivateTranscriptionAudioStore } from './transcription-audio-custody';
import { PostgresTranscriptionRepository } from './transcription-postgres';
import { TranscriptionService, type TranscriptionProvider } from './transcriptions';

export interface TranscriptionRuntime {
  service: TranscriptionService;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createTranscriptionRuntime(options: {
  onError?: (error: unknown) => void;
  audioDir?: string;
  /** Explicit provider injection for provider-free runtimes; undefined alone enables env resolution. */
  provider?: TranscriptionProvider | null;
} = {}): Promise<TranscriptionRuntime> {
  const env = getEnv();
  const audio = new PrivateTranscriptionAudioStore(options.audioDir ?? env.TRANSCRIPTION_AUDIO_DIR);
  await audio.initialize();
  const repository = new PostgresTranscriptionRepository({
    audio,
    dailyMannaCap: env.DAILY_MANNA_SPEND_CAP_PER_USER,
    maxActivePerOwner: env.TRANSCRIPTION_MAX_ACTIVE_PER_USER,
    maxCreatedPerOwnerPerDay: env.TRANSCRIPTION_MAX_CREATED_PER_USER_PER_DAY,
  });
  const provider = options.provider === undefined
    ? (env.CARTESIA_API_KEY
        ? new CartesiaTranscriptionProvider({ apiKey: env.CARTESIA_API_KEY })
        : null)
    : options.provider;
  const service = new TranscriptionService({ repository, provider });
  let loop: BackgroundWorkerLoop | null = null;
  return {
    service,
    async start() {
      if (loop) return;
      loop = await startBackgroundWorkerLoop({
        intervalMs: env.TRANSCRIPTION_WORKER_INTERVAL_MS,
        tick: () => service.runOnce(),
        onResult: () => undefined,
        onError: options.onError ?? (() => undefined),
      });
    },
    async stop() {
      await loop?.stop();
      loop = null;
    },
  };
}
