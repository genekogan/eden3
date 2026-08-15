import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface MaterializedMediaRoots {
  mediaDir: string;
  transcriptionAudioDir: string;
  voiceOutputDir: string;
}

function overlaps(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Materialize and physically attest the three roots before any bytes are written. */
export async function materializeMediaRoots(input: MaterializedMediaRoots): Promise<MaterializedMediaRoots> {
  await Promise.all([
    mkdir(input.mediaDir, { recursive: true }),
    mkdir(input.transcriptionAudioDir, { recursive: true, mode: 0o700 }),
    mkdir(input.voiceOutputDir, { recursive: true, mode: 0o700 }),
  ]);
  const [mediaDir, transcriptionAudioDir, voiceOutputDir] = await Promise.all([
    realpath(input.mediaDir),
    realpath(input.transcriptionAudioDir),
    realpath(input.voiceOutputDir),
  ]);
  for (const [name, candidate] of [
    ['TRANSCRIPTION_AUDIO_DIR', transcriptionAudioDir],
    ['VOICE_OUTPUT_DIR', voiceOutputDir],
  ] as const) {
    if (overlaps(mediaDir, candidate) || overlaps(candidate, mediaDir)) {
      throw new Error(`${name} must be physically outside MEDIA_DIR`);
    }
  }
  if (overlaps(transcriptionAudioDir, voiceOutputDir) || overlaps(voiceOutputDir, transcriptionAudioDir)) {
    throw new Error('VOICE_OUTPUT_DIR must be physically separate from TRANSCRIPTION_AUDIO_DIR');
  }
  await Promise.all([chmod(transcriptionAudioDir, 0o700), chmod(voiceOutputDir, 0o700)]);
  const [transcriptionStat, voiceStat] = await Promise.all([
    lstat(transcriptionAudioDir),
    lstat(voiceOutputDir),
  ]);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const [name, stat] of [
    ['TRANSCRIPTION_AUDIO_DIR', transcriptionStat],
    ['VOICE_OUTPUT_DIR', voiceStat],
  ] as const) {
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 ||
        (uid !== null && stat.uid !== uid)) {
      throw new Error(`${name} must be an owner-only real directory`);
    }
  }
  return { mediaDir, transcriptionAudioDir, voiceOutputDir };
}
