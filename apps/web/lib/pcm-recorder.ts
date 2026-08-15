const PCM_SAMPLE_RATE = 16_000;
export const PCM_UPLOAD_CHUNK_SAMPLES = 16_000;

export interface PcmChunk {
  audio: Blob;
  durationMs: number;
}

export class PcmRecorder {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private silentGain: GainNode | null = null;
  private totalSamples = 0;
  private stopping: Promise<void> | null = null;

  constructor(
    private readonly stream: MediaStream,
    private readonly onChunk: (chunk: PcmChunk) => void,
    private readonly onError: (error: Error) => void,
  ) {}

  static supported(): boolean {
    return (
      typeof AudioContext !== "undefined" &&
      typeof AudioWorkletNode !== "undefined"
    );
  }

  async start(): Promise<void> {
    if (this.context) return;
    const context = new AudioContext({ latencyHint: "interactive" });
    this.context = context;
    await context.audioWorklet.addModule("/audio/pcm-recorder-worklet.js");
    const source = context.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(context, "eden-pcm16-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const silentGain = context.createGain();
    silentGain.gain.value = 0;
    node.port.addEventListener("message", (event: MessageEvent<unknown>) => {
      const message = event.data as { type?: string; samples?: ArrayBuffer };
      if (message.type !== "chunk" || !(message.samples instanceof ArrayBuffer)) return;
      const sampleCount = message.samples.byteLength / Int16Array.BYTES_PER_ELEMENT;
      this.totalSamples += sampleCount;
      this.onChunk({
        audio: new Blob([message.samples], { type: "application/octet-stream" }),
        durationMs: Math.round((this.totalSamples / PCM_SAMPLE_RATE) * 1_000),
      });
    });
    node.addEventListener("processorerror", () => {
      this.onError(new Error("The microphone audio processor stopped unexpectedly."));
    });
    node.port.start();
    source.connect(node);
    node.connect(silentGain);
    silentGain.connect(context.destination);
    this.source = source;
    this.node = node;
    this.silentGain = silentGain;
    await context.resume();
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      const context = this.context;
      const node = this.node;
      this.source?.disconnect();
      if (node && context && context.state !== "closed") {
        await new Promise<void>((resolve) => {
          const onMessage = (event: MessageEvent<unknown>) => {
            const message = event.data as { type?: string };
            if (message.type !== "flush_done") return;
            clearTimeout(timeout);
            node.port.removeEventListener("message", onMessage);
            resolve();
          };
          const timeout = setTimeout(() => {
            node.port.removeEventListener("message", onMessage);
            resolve();
          }, 750);
          node.port.addEventListener("message", onMessage);
          node.port.postMessage("flush");
        });
      }
      node?.disconnect();
      this.silentGain?.disconnect();
      if (context && context.state !== "closed") await context.close();
      this.context = null;
      this.source = null;
      this.node = null;
      this.silentGain = null;
    })();
    return this.stopping;
  }
}
