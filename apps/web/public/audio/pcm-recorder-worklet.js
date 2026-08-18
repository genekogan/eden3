/* Eden dictation capture: mono PCM16LE at 16 kHz, emitted every second. */
class EdenPcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.sourcePerTarget = sampleRate / this.targetRate;
    this.nextOutputAt = 0;
    this.sourceIndex = 0;
    this.previous = 0;
    this.hasPrevious = false;
    this.output = [];
    // One 32 KiB browser→Eden chunk per second avoids thousands of HTTP
    // requests during a long dictation. The backend can replay the bytes to
    // its provider adapter in smaller realtime frames.
    this.outputChunkSamples = 16000;
    // The transcription API accepts only complete 10 ms PCM frames. Regular
    // one-second emissions are already aligned; the final flush usually is
    // not, so pad only that tail with silence instead of dropping speech.
    this.frameSamples = 160;
    this.port.onmessage = (event) => {
      if (event.data === "flush") {
        this.emit(true);
        this.port.postMessage({ type: "flush_done" });
      }
    };
  }

  push(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.output.push(clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767));
    if (this.output.length >= this.outputChunkSamples) this.emit(false);
  }

  emit(force) {
    if (this.output.length === 0 || (!force && this.output.length < this.outputChunkSamples)) return;
    if (force) {
      const remainder = this.output.length % this.frameSamples;
      if (remainder !== 0) {
        this.output.push(...new Array(this.frameSamples - remainder).fill(0));
      }
    }
    const samples = new Int16Array(this.output);
    this.output = [];
    this.port.postMessage({ type: "chunk", samples: samples.buffer }, [samples.buffer]);
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || channels[0].length === 0) return true;
    const frames = channels[0].length;
    for (let frame = 0; frame < frames; frame += 1) {
      let current = 0;
      for (let channel = 0; channel < channels.length; channel += 1) {
        current += channels[channel][frame] || 0;
      }
      current /= channels.length;

      if (!this.hasPrevious) {
        this.previous = current;
        this.hasPrevious = true;
        this.push(current);
        this.nextOutputAt = this.sourcePerTarget;
        this.sourceIndex = 1;
        continue;
      }

      while (this.nextOutputAt <= this.sourceIndex) {
        const fraction = this.nextOutputAt - (this.sourceIndex - 1);
        this.push(this.previous + (current - this.previous) * fraction);
        this.nextOutputAt += this.sourcePerTarget;
      }
      this.previous = current;
      this.sourceIndex += 1;
    }
    return true;
  }
}

registerProcessor("eden-pcm16-recorder", EdenPcmRecorderProcessor);
