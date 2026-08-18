import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
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
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const EXTERNAL_PEER_ID = /^-?[0-9]{3,25}$/;
const DEFAULT_STATE_FILE = '/home/node/.openclaw/eden3-channel-pairing-callbacks.json';
const MAX_ENTRIES = 256;
const AAD = Buffer.from('eden3:channel-pairing-callback-outbox:v1', 'utf8');

function markerKey(marker) {
  return `${marker.connectionId}\0${marker.runtimeAccountId}\0${marker.peerId}`;
}

function validateMarker(marker) {
  if (
    !marker ||
    typeof marker !== 'object' ||
    !UUID.test(marker.connectionId) ||
    !RUNTIME_ACCOUNT.test(marker.runtimeAccountId) ||
    (marker.channel !== 'discord' && marker.channel !== 'telegram') ||
    !AGENT_ID.test(marker.agentId) ||
    (marker.bindingId !== undefined && !UUID.test(marker.bindingId)) ||
    !EXTERNAL_PEER_ID.test(marker.peerId) ||
    typeof marker.code !== 'string' ||
    marker.code.length < 1 ||
    marker.code.length > 128 ||
    !Number.isSafeInteger(marker.expiresAt) ||
    marker.expiresAt <= 0
  ) {
    throw new Error('invalid channel pairing callback marker');
  }
  return Object.freeze({
    connectionId: marker.connectionId.toLowerCase(),
    runtimeAccountId: marker.runtimeAccountId,
    channel: marker.channel,
    agentId: marker.agentId,
    ...(marker.bindingId ? { bindingId: marker.bindingId.toLowerCase() } : {}),
    peerId: marker.peerId,
    code: marker.code,
    expiresAt: marker.expiresAt,
  });
}

function deriveKey(secret) {
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 8_192) {
    throw new Error('channel pairing callback encryption unavailable');
  }
  return createHash('sha256')
    .update('eden3:channel-pairing-callback-key:v1\0', 'utf8')
    .update(secret, 'utf8')
    .digest();
}

function encryptMarker(marker, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(validateMarker(marker)), 'utf8'),
    cipher.final(),
  ]);
  return {
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptMarker(envelope, key) {
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    typeof envelope.nonce !== 'string' ||
    typeof envelope.ciphertext !== 'string' ||
    typeof envelope.tag !== 'string'
  ) {
    throw new Error('invalid encrypted channel pairing callback outbox');
  }
  try {
    const nonce = Buffer.from(envelope.nonce, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length < 1) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      'utf8',
    );
    return validateMarker(JSON.parse(plaintext));
  } catch {
    throw new Error('invalid encrypted channel pairing callback outbox');
  }
}

function parseState(raw, key) {
  const parsed = JSON.parse(raw);
  if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error('invalid encrypted channel pairing callback outbox');
  }
  if (parsed.entries.length > MAX_ENTRIES) {
    throw new Error('channel pairing callback outbox is too large');
  }
  const entries = new Map();
  for (const envelope of parsed.entries) {
    const marker = decryptMarker(envelope, key);
    const markerId = markerKey(marker);
    if (entries.has(markerId)) {
      throw new Error('duplicate channel pairing callback marker');
    }
    entries.set(markerId, marker);
  }
  return entries;
}

function durableReplace(filePath, body) {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  let renamed = false;
  try {
    descriptor = openSync(temp, 'wx', 0o600);
    writeFileSync(descriptor, body, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temp, filePath);
    renamed = true;
    const directoryDescriptor = openSync(directory, 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (cause) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original durability failure.
      }
    }
    if (!renamed) {
      try {
        unlinkSync(temp);
      } catch {
        // A failed pre-rename temporary file is inert.
      }
    }
    const error = new Error('failed to durably replace channel pairing callback outbox', {
      cause,
    });
    error.renamed = renamed;
    throw error;
  }
}

export function createDurablePairingCallbackOutbox(options = {}) {
  const filePath =
    options.filePath ??
    process.env.EDEN3_CHANNEL_PAIRING_CALLBACK_FILE ??
    DEFAULT_STATE_FILE;
  const key = deriveKey(options.secret ?? process.env.OPENCLAW_GATEWAY_TOKEN);
  let entries = new Map();
  try {
    entries = parseState(readFileSync(filePath, 'utf8'), key);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  function persist(nextEntries) {
    durableReplace(
      filePath,
      JSON.stringify({
        version: 1,
        entries: [...nextEntries.values()].map((marker) => encryptMarker(marker, key)),
      }),
    );
  }

  return Object.freeze({
    record(rawMarker) {
      const marker = validateMarker(rawMarker);
      const keyId = markerKey(marker);
      if (!entries.has(keyId) && entries.size >= MAX_ENTRIES) {
        throw new Error('channel pairing callback outbox is full');
      }
      const previous = entries.get(keyId);
      const nextEntries = new Map(entries);
      nextEntries.set(keyId, marker);
      try {
        persist(nextEntries);
        entries = nextEntries;
      } catch (error) {
        if (error?.renamed) entries = nextEntries;
        else if (previous) entries.set(keyId, previous);
        throw error;
      }
      return marker;
    },

    list() {
      return [...entries.values()].map((marker) => ({ ...marker }));
    },

    remove(rawMarker) {
      const marker = validateMarker(rawMarker);
      const keyId = markerKey(marker);
      const existing = entries.get(keyId);
      if (!existing) return false;
      if (existing.code !== marker.code || existing.expiresAt !== marker.expiresAt) {
        throw new Error('channel pairing callback marker conflict');
      }
      const nextEntries = new Map(entries);
      nextEntries.delete(keyId);
      try {
        persist(nextEntries);
        entries = nextEntries;
      } catch (error) {
        if (error?.renamed) entries = nextEntries;
        throw error;
      }
      return true;
    },
  });
}

export const pairingCallbackOutboxInternals = {
  DEFAULT_STATE_FILE,
  MAX_ENTRIES,
  markerKey,
  parseState,
  validateMarker,
};
