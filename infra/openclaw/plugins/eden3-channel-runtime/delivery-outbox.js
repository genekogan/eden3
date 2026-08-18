import { randomUUID } from 'node:crypto';
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIME_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_STATE_FILE = '/home/node/.openclaw/eden3-channel-delivery-success.json';
const MAX_ENTRIES = 10_000;

function markerKey(marker) {
  return `${marker.connectionId}\0${marker.turnId}`;
}

function validateMarker(marker) {
  if (
    !marker ||
    typeof marker !== 'object' ||
    !UUID.test(marker.connectionId) ||
    !UUID.test(marker.turnId) ||
    !RUNTIME_ACCOUNT.test(marker.runtimeAccountId) ||
    (marker.channel !== 'discord' && marker.channel !== 'telegram') ||
    typeof marker.messageId !== 'string' ||
    marker.messageId.length < 1 ||
    marker.messageId.length > 500
  ) {
    throw new Error('invalid channel delivery-success marker');
  }
  return Object.freeze({
    connectionId: marker.connectionId.toLowerCase(),
    runtimeAccountId: marker.runtimeAccountId,
    channel: marker.channel,
    turnId: marker.turnId.toLowerCase(),
    messageId: marker.messageId,
  });
}

function parseState(raw) {
  const parsed = JSON.parse(raw);
  if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error('invalid channel delivery-success outbox');
  }
  const entries = new Map();
  for (const rawMarker of parsed.entries) {
    const marker = validateMarker(rawMarker);
    const key = markerKey(marker);
    if (entries.has(key)) throw new Error('duplicate channel delivery-success marker');
    entries.set(key, marker);
  }
  if (entries.size > MAX_ENTRIES) throw new Error('channel delivery-success outbox is too large');
  const quarantined = Array.isArray(parsed.quarantined)
    ? parsed.quarantined.slice(-1_000).map((item) => ({
        ...validateMarker(item),
        reason:
          typeof item.reason === 'string' && item.reason.length <= 100
            ? item.reason
            : 'unknown',
      }))
    : [];
  return { entries, quarantined };
}

function durableReplace(filePath, body) {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let fileDescriptor;
  let renamed = false;
  try {
    fileDescriptor = openSync(temp, 'wx', 0o600);
    writeFileSync(fileDescriptor, body, { encoding: 'utf8' });
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    renameSync(temp, filePath);
    renamed = true;
    const directoryDescriptor = openSync(directory, 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (cause) {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // Preserve the original durability failure.
      }
    }
    if (!renamed) {
      try {
        unlinkSync(temp);
      } catch {
        // A failed pre-rename temporary file is inert and contains no secret.
      }
    }
    const error = new Error('failed to durably replace channel delivery-success outbox', {
      cause,
    });
    error.renamed = renamed;
    throw error;
  }
}

export function createDurableDeliverySuccessOutbox(options = {}) {
  const filePath =
    options.filePath ??
    process.env.EDEN3_CHANNEL_DELIVERY_SUCCESS_FILE ??
    DEFAULT_STATE_FILE;
  let entries = new Map();
  let quarantined = [];
  try {
    ({ entries, quarantined } = parseState(readFileSync(filePath, 'utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  function persist() {
    durableReplace(
      filePath,
      JSON.stringify({ version: 1, entries: [...entries.values()], quarantined }),
    );
  }

  return Object.freeze({
    record(rawMarker) {
      const marker = validateMarker(rawMarker);
      const key = markerKey(marker);
      const existing = entries.get(key);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(marker)) {
          throw new Error('channel delivery-success marker conflict');
        }
        return existing;
      }
      if (entries.size >= MAX_ENTRIES) throw new Error('channel delivery-success outbox is full');
      entries.set(key, marker);
      try {
        persist();
      } catch (error) {
        // Once rename succeeded, the new file is the authoritative recovery
        // state even if directory fsync reported failure. Retaining memory
        // prevents a later write in this process from erasing that marker.
        if (!error?.renamed) entries.delete(key);
        throw error;
      }
      return marker;
    },

    list() {
      return [...entries.values()];
    },

    listQuarantined() {
      return quarantined.map((marker) => ({ ...marker }));
    },

    remove(rawMarker) {
      const marker = validateMarker(rawMarker);
      const key = markerKey(marker);
      const existing = entries.get(key);
      if (!existing) return false;
      if (JSON.stringify(existing) !== JSON.stringify(marker)) {
        throw new Error('channel delivery-success marker conflict');
      }
      entries.delete(key);
      try {
        persist();
      } catch (error) {
        if (!error?.renamed) entries.set(key, existing);
        throw error;
      }
      return true;
    },

    quarantine(rawMarker, reason) {
      const marker = validateMarker(rawMarker);
      const key = markerKey(marker);
      const existing = entries.get(key);
      if (!existing) return false;
      if (JSON.stringify(existing) !== JSON.stringify(marker)) {
        throw new Error('channel delivery-success marker conflict');
      }
      const prior = quarantined;
      entries.delete(key);
      quarantined = [...quarantined, { ...existing, reason: String(reason).slice(0, 100) }].slice(-1_000);
      try {
        persist();
      } catch (error) {
        if (!error?.renamed) {
          entries.set(key, existing);
          quarantined = prior;
        }
        throw error;
      }
      return true;
    },
  });
}

export const deliverySuccessOutboxInternals = {
  DEFAULT_STATE_FILE,
  markerKey,
  parseState,
  validateMarker,
};
