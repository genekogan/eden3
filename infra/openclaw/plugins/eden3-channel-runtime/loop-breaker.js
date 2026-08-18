import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const BOT_LOOP_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_STATE_FILE = '/home/node/.openclaw/eden3-channel-loop-state.json';
const MAX_ENTRIES = 10_000;
const DEFAULT_IO = Object.freeze({
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
});

function loopKey(connectionId, conversationId) {
  return createHash('sha256')
    .update('eden3-channel-bot-loop\0')
    .update(connectionId)
    .update('\0')
    .update(conversationId)
    .digest('hex');
}

function parseState(raw) {
  const parsed = JSON.parse(raw);
  if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('invalid loop state');
  const entries = new Map();
  for (const item of parsed.entries) {
    if (
      !Array.isArray(item) ||
      item.length !== 2 ||
      typeof item[0] !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item[0]) ||
      !Number.isFinite(item[1])
    ) {
      throw new Error('invalid loop entry');
    }
    entries.set(item[0], item[1]);
  }
  return entries;
}

export function createDurableBotLoopBreaker(options = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? BOT_LOOP_TTL_MS;
  const filePath = options.filePath ?? process.env.EDEN3_CHANNEL_LOOP_STATE_FILE ?? DEFAULT_STATE_FILE;
  const io = options.io ?? DEFAULT_IO;
  let healthy = true;
  let entries = new Map();
  try {
    entries = parseState(io.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') healthy = false;
  }

  function prune() {
    const current = now();
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= current) entries.delete(key);
    }
    if (entries.size > MAX_ENTRIES) {
      const oldest = [...entries.entries()].sort((a, b) => a[1] - b[1]);
      for (const [key] of oldest.slice(0, entries.size - MAX_ENTRIES)) entries.delete(key);
    }
  }

  function persist() {
    prune();
    const directory = dirname(filePath);
    io.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let fileDescriptor;
    let renamed = false;
    try {
      fileDescriptor = io.openSync(temp, 'wx', 0o600);
      io.writeFileSync(fileDescriptor, JSON.stringify({ version: 1, entries: [...entries] }), {
        encoding: 'utf8',
      });
      io.fsyncSync(fileDescriptor);
      io.closeSync(fileDescriptor);
      fileDescriptor = undefined;
      io.renameSync(temp, filePath);
      renamed = true;
      const directoryDescriptor = io.openSync(directory, 'r');
      try {
        io.fsyncSync(directoryDescriptor);
      } finally {
        io.closeSync(directoryDescriptor);
      }
      healthy = true;
    } catch (cause) {
      if (fileDescriptor !== undefined) {
        try {
          io.closeSync(fileDescriptor);
        } catch {
          // Preserve the original persistence failure.
        }
      }
      if (!renamed) {
        try {
          io.unlinkSync(temp);
        } catch {
          // An unlinked temporary file is not authoritative loop state.
        }
      }
      throw new Error('failed to durably replace channel bot-loop state', { cause });
    }
  }

  return Object.freeze({
    /** Human traffic opens a fresh bounded bot-reply window. */
    observeHuman(connectionId, conversationId) {
      if (!healthy) return false;
      entries.delete(loopKey(connectionId, conversationId));
      try {
        persist();
        return true;
      } catch {
        healthy = false;
        return false;
      }
    },

    /** Allow exactly the first bot-authored trigger in a conversation window. */
    admitBot(connectionId, conversationId) {
      if (!healthy) return false;
      prune();
      const key = loopKey(connectionId, conversationId);
      if ((entries.get(key) ?? 0) > now()) return false;
      entries.set(key, now() + ttlMs);
      try {
        persist();
        return true;
      } catch {
        healthy = false;
        return false;
      }
    },
  });
}

export const botLoopBreakerInternals = { DEFAULT_STATE_FILE, loopKey };
