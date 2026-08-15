import Cartesia from '@cartesia/cartesia-js';

import {
  TRANSCRIPTION_MODEL,
  TRANSCRIPTION_MAX_TRANSCRIPT_CHARS,
  TranscriptionProviderError,
  type TranscriptionFormat,
  type TranscriptionProvider,
  type TranscriptionProviderResult,
} from './transcriptions';

const CARTESIA_TIMEOUT_MS = 12 * 60 * 1_000;
const CARTESIA_CHUNK_BYTES = 3_200; // 100ms PCM16LE/16kHz mono
const CARTESIA_MAX_MESSAGE_BYTES = 512_000;

export function appendTranscriptDelta(transcript: string, delta: string): string {
  if (delta.length > TRANSCRIPTION_MAX_TRANSCRIPT_CHARS - transcript.length) {
    throw new TranscriptionProviderError('provider_response_invalid');
  }
  return transcript + delta;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Trusted-server Cartesia adapter. The API key never crosses this boundary. */
export class CartesiaTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'cartesia';
  readonly model = TRANSCRIPTION_MODEL;
  private readonly client: Cartesia;
  private readonly timeoutMs: number;

  constructor(options: { apiKey: string; timeoutMs?: number }) {
    if (!options.apiKey) throw new Error('Cartesia transcription requires CARTESIA_API_KEY');
    this.client = new Cartesia({ apiKey: options.apiKey });
    this.timeoutMs = options.timeoutMs ?? CARTESIA_TIMEOUT_MS;
  }

  async transcribe(input: {
    sessionId: string;
    language: 'en';
    format: TranscriptionFormat;
    chunks: readonly Buffer[];
    durationMs: number;
    isCancelled: () => Promise<boolean>;
  }): Promise<TranscriptionProviderResult> {
    const ws = this.client.stt.manualFinalize.websocket(
      {
        model: TRANSCRIPTION_MODEL,
        encoding: input.format.encoding,
        sample_rate: input.format.sampleRateHz,
        language: input.language,
      },
      {
        reconnect: null,
        maxQueueSize: CARTESIA_CHUNK_BYTES * 4,
        maxPayload: CARTESIA_MAX_MESSAGE_BYTES,
      },
    );
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        this.runSession(ws, input),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new TranscriptionProviderError('provider_timeout')),
            this.timeoutMs,
          );
        }),
      ]);
      return result;
    } catch (error) {
      if (error instanceof TranscriptionProviderError) throw error;
      throw new TranscriptionProviderError('provider_unavailable');
    } finally {
      if (timer) clearTimeout(timer);
      ws.close({ code: 1000, reason: 'Eden transcription complete' });
    }
  }

  private async runSession(
    ws: ReturnType<Cartesia['stt']['manualFinalize']['websocket']>,
    input: {
      chunks: readonly Buffer[];
      durationMs: number;
      isCancelled: () => Promise<boolean>;
    },
  ): Promise<TranscriptionProviderResult> {
    let resolveOpened!: () => void;
    let rejectOpened!: (error: Error) => void;
    const opened = new Promise<void>((resolve, reject) => {
      resolveOpened = resolve;
      rejectOpened = reject;
    });
    let stopped = false;
    const receive = (async () => {
      try {
        let transcript = '';
        let requestId: string | null = null;
        for await (const event of ws.stream()) {
          if (event.type === 'open') {
            resolveOpened();
            continue;
          }
          if (event.type === 'error') {
            const status = event.error.error?.status_code;
            const code = status === 429
              ? 'provider_rate_limited'
              : status === 401 || status === 403
                ? 'provider_auth_error'
                : 'provider_error';
            const failure = new TranscriptionProviderError(code);
            rejectOpened(failure);
            throw failure;
          }
          if (event.type === 'close') {
            const failure = new TranscriptionProviderError('provider_unavailable');
            rejectOpened(failure);
            throw failure;
          }
          if (event.type !== 'message') continue;
          requestId = 'request_id' in event.message
            ? event.message.request_id ?? requestId
            : requestId;
          if (event.message.type === 'transcript' && event.message.is_final) {
            // Cartesia transcript events are deltas; preserve whitespace exactly.
            transcript = appendTranscriptDelta(transcript, event.message.text);
          }
          if (event.message.type === 'done') {
            return {
              transcript,
              providerRequestId: requestId,
              durationMs: input.durationMs,
            };
          }
        }
        throw new TranscriptionProviderError('provider_unavailable');
      } finally {
        stopped = true;
      }
    })();
    // Attach a rejection handler before waiting for open so an immediate
    // provider failure can never become an unhandled rejection.
    void receive.catch(() => undefined);

    await opened;
    const send = (async () => {
      for (const durableChunk of input.chunks) {
        for (let offset = 0; offset < durableChunk.length; offset += CARTESIA_CHUNK_BYTES) {
          if (stopped) throw new TranscriptionProviderError('provider_unavailable');
          if (await input.isCancelled()) {
            throw new TranscriptionProviderError('transcription_deleted');
          }
          const frame = durableChunk.subarray(offset, offset + CARTESIA_CHUNK_BYTES);
          ws.sendRaw(frame);
          await delay((frame.length / 32_000) * 1_000);
        }
      }
      if (stopped) throw new TranscriptionProviderError('provider_unavailable');
      if (await input.isCancelled()) {
        throw new TranscriptionProviderError('transcription_deleted');
      }
      ws.send('finalize');
      ws.send('close');
    })();
    void send.catch(() => undefined);

    const first = await Promise.race([
      receive.then((result) => ({ kind: 'received' as const, result })),
      send.then(() => ({ kind: 'sent' as const })),
    ]);
    return first.kind === 'received' ? first.result : await receive;
  }
}
