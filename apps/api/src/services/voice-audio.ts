import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class VoiceAudioError extends Error {
  constructor(readonly code: 'transcode_failed' | 'transcode_timeout' | 'audio_invalid' | 'duration_exceeded' | 'output_too_large') {
    super(code);
    this.name = 'VoiceAudioError';
  }
}

export interface ProcessedVoiceAudio {
  bytes: Buffer;
  mime: 'audio/mpeg' | 'audio/ogg';
  durationMs: number;
  waveform: string | null;
}

export interface VoiceAudioProcessor {
  inspectClip(input: Buffer, mime: 'audio/wav' | 'audio/mpeg'): Promise<{ durationMs: number }>;
  combineCloneClips(inputs: ReadonlyArray<{ bytes: Buffer; mime: 'audio/wav' | 'audio/mpeg' }>): Promise<{
    bytes: Buffer;
    mime: 'audio/wav';
    durationMs: number;
  }>;
  process(input: Buffer, mime: string, purpose: 'preview' | 'chat' | 'discord' | 'telegram'): Promise<ProcessedVoiceAudio>;
}

interface Probe {
  format?: { duration?: string; size?: string };
  streams?: Array<{ codec_type?: string; codec_name?: string; channels?: number; sample_rate?: string }>;
}

async function run(argv: readonly string[], timeoutMs: number): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= 1024 * 1024) target.push(chunk);
      else child.kill('SIGKILL');
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref?.();
    child.once('error', () => {
      clearTimeout(timer);
      reject(new VoiceAudioError('transcode_failed'));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') return reject(new VoiceAudioError('transcode_timeout'));
      if (code !== 0) return reject(new VoiceAudioError('transcode_failed'));
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

async function probe(filePath: string): Promise<{ durationMs: number; codec: string; channels: number }> {
  const result = await run([
    'ffprobe', '-v', 'error', '-show_entries',
    'format=duration,size:stream=codec_type,codec_name,channels,sample_rate',
    '-of', 'json', filePath,
  ], 8_000);
  let parsed: Probe;
  try { parsed = JSON.parse(result.stdout.toString('utf8')) as Probe; } catch { throw new VoiceAudioError('audio_invalid'); }
  const audio = parsed.streams?.filter((stream) => stream.codec_type === 'audio') ?? [];
  if (audio.length !== 1 || (parsed.streams?.length ?? 0) !== 1) throw new VoiceAudioError('audio_invalid');
  const durationSeconds = Number(parsed.format?.duration);
  const channels = audio[0]?.channels;
  const codec = audio[0]?.codec_name;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isSafeInteger(channels) || channels! < 1 || channels! > 2 || typeof codec !== 'string') {
    throw new VoiceAudioError('audio_invalid');
  }
  return { durationMs: Math.ceil(durationSeconds * 1000), codec, channels: channels! };
}

function waveform(bytes: Buffer): string {
  const points = 64;
  const values = Buffer.alloc(points);
  for (let i = 0; i < points; i += 1) {
    const start = Math.floor((i * bytes.length) / points);
    const end = Math.max(start + 1, Math.floor(((i + 1) * bytes.length) / points));
    let max = 0;
    for (let j = start; j < Math.min(end, bytes.length); j += 1) max = Math.max(max, bytes[j]!);
    values[i] = max;
  }
  return values.toString('base64');
}

const LIMITS = {
  preview: { durationMs: 30_000, bytes: 2 * 1024 * 1024 },
  chat: { durationMs: 300_000, bytes: 8 * 1024 * 1024 },
  discord: { durationMs: 120_000, bytes: 8 * 1024 * 1024 },
  telegram: { durationMs: 120_000, bytes: 8 * 1024 * 1024 },
} as const;

const CLONE_CLIP_LIMITS = { minimumDurationMs: 100, maximumDurationMs: 30_000, maximumBytes: 20 * 1024 * 1024 } as const;

export class FfmpegVoiceAudioProcessor implements VoiceAudioProcessor {
  constructor(private readonly root = path.join(tmpdir(), 'eden3-voice')) {}

  private async withFile<T>(bytes: Buffer, mime: string, task: (inputPath: string, dir: string) => Promise<T>): Promise<T> {
    const dir = path.join(this.root, randomUUID());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const ext = mime === 'audio/wav' ? '.wav' : mime === 'audio/ogg' ? '.ogg' : '.mp3';
    const inputPath = path.join(dir, `input${ext}`);
    try {
      await writeFile(inputPath, bytes, { mode: 0o600 });
      return await task(inputPath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async inspectClip(input: Buffer, mime: 'audio/wav' | 'audio/mpeg'): Promise<{ durationMs: number }> {
    if (input.length === 0 || input.length > CLONE_CLIP_LIMITS.maximumBytes) throw new VoiceAudioError('audio_invalid');
    return await this.withFile(input, mime, async (inputPath, dir) => {
      const info = await probe(inputPath);
      if (info.durationMs < CLONE_CLIP_LIMITS.minimumDurationMs || info.durationMs > CLONE_CLIP_LIMITS.maximumDurationMs) throw new VoiceAudioError('duration_exceeded');
      const analysisPath = path.join(dir, 'analysis.pcm');
      await run([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', inputPath,
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
        '-t', '30', '-f', 's16le', analysisPath,
      ], 12_000);
      const pcm = await readFile(analysisPath);
      if (pcm.length < 16000 * 2 * (CLONE_CLIP_LIMITS.minimumDurationMs / 1000) || pcm.length > 16000 * 2 * 30 + 4096 || pcm.length % 2 !== 0) {
        throw new VoiceAudioError('audio_invalid');
      }
      let energy = 0;
      let clipped = 0;
      const samples = pcm.length / 2;
      for (let offset = 0; offset < pcm.length; offset += 2) {
        const sample = pcm.readInt16LE(offset);
        energy += sample * sample;
        if (Math.abs(sample) >= 32700) clipped += 1;
      }
      const rms = Math.sqrt(energy / samples);
      if (rms < 100 || clipped / samples > 0.01) throw new VoiceAudioError('audio_invalid');
      return { durationMs: info.durationMs };
    });
  }

  async combineCloneClips(inputs: ReadonlyArray<{ bytes: Buffer; mime: 'audio/wav' | 'audio/mpeg' }>): Promise<{
    bytes: Buffer;
    mime: 'audio/wav';
    durationMs: number;
  }> {
    if (inputs.length < 1 || inputs.length > 5) throw new VoiceAudioError('audio_invalid');
    const dir = path.join(this.root, randomUUID());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      const inputPaths: string[] = [];
      for (const [index, input] of inputs.entries()) {
        if (input.bytes.length === 0 || input.bytes.length > 20 * 1024 * 1024) throw new VoiceAudioError('audio_invalid');
        const inputPath = path.join(dir, `clip-${index}${input.mime === 'audio/wav' ? '.wav' : '.mp3'}`);
        await writeFile(inputPath, input.bytes, { mode: 0o600 });
        inputPaths.push(inputPath);
      }
      const outputPath = path.join(dir, 'combined.wav');
      const inputArgs = inputPaths.flatMap((inputPath) => ['-i', inputPath]);
      const streams = inputPaths.map((_, index) => `[${index}:a:0]`).join('');
      await run([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', ...inputArgs,
        '-filter_complex', `${streams}concat=n=${inputPaths.length}:v=0:a=1[out]`,
        '-map', '[out]', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', outputPath,
      ], 20_000);
      const bytes = await readFile(outputPath);
      const info = await probe(outputPath);
      if (info.durationMs < 5_000 || info.durationMs > 30_000 || bytes.length > 40 * 1024 * 1024) {
        throw new VoiceAudioError('duration_exceeded');
      }
      return { bytes, mime: 'audio/wav', durationMs: info.durationMs };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async process(input: Buffer, mime: string, purpose: keyof typeof LIMITS): Promise<ProcessedVoiceAudio> {
    const limit = LIMITS[purpose];
    if (input.length === 0 || input.length > 10 * 1024 * 1024) throw new VoiceAudioError('output_too_large');
    return await this.withFile(input, mime, async (inputPath, dir) => {
      const before = await probe(inputPath);
      if (before.durationMs > limit.durationMs) throw new VoiceAudioError('duration_exceeded');
      const ogg = purpose === 'discord' || purpose === 'telegram';
      const outputPath = path.join(dir, ogg ? 'output.ogg' : 'output.mp3');
      await run(ogg
        ? ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', inputPath, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg', outputPath]
        : ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', inputPath, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', outputPath],
      20_000);
      const output = await readFile(outputPath);
      const after = await probe(outputPath);
      if (after.durationMs > limit.durationMs) throw new VoiceAudioError('duration_exceeded');
      if (output.length === 0 || output.length > limit.bytes) throw new VoiceAudioError('output_too_large');
      if (ogg && after.codec !== 'opus') throw new VoiceAudioError('audio_invalid');
      return {
        bytes: output,
        mime: ogg ? 'audio/ogg' : 'audio/mpeg',
        durationMs: after.durationMs,
        waveform: purpose === 'discord' ? waveform(output) : null,
      };
    });
  }
}

export const voiceAudioInternals = { LIMITS, CLONE_CLIP_LIMITS, waveform };
