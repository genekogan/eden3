#!/usr/local/bin/node

import { createHmac } from 'node:crypto';
import net from 'node:net';

const PROTOCOL_VERSION = 2;
const PROVIDER = 'eden-channel-vault';
const MAX_FRAME_BYTES = 262_144;
const TIMEOUT_MS = 4_500;
const GENERIC_ERROR = 'channel secret resolver unavailable\n';
const REQUESTER_DOMAIN = 'eden3-channel-request-v2';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function socketArgument(argv) {
  if (argv.length !== 2 || argv[0] !== '--socket' || !argv[1]?.startsWith('/')) return null;
  return argv[1];
}

function fail() {
  process.stderr.write(GENERIC_ERROR);
  process.exitCode = 1;
}

function parseRequesterKey(raw) {
  if (typeof raw !== 'string') throw new Error('invalid requester key');
  const trimmed = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) throw new Error('invalid requester key');
  return key;
}

function canonicalRequester(requester) {
  if (!requester || typeof requester !== 'object' || Array.isArray(requester)) {
    throw new Error('invalid requester');
  }
  const expectedField = requester.channel === 'discord' ? 'token' : 'botToken';
  const expectedPath =
    `channels.${requester.channel}.accounts.${requester.runtimeAccountId}.${requester.credentialField}`;
  const parts = [
    requester.id,
    requester.configPath,
    requester.connectionId,
    requester.channel,
    requester.runtimeAccountId,
    requester.agentId,
    requester.credentialField,
  ];
  if (
    Object.keys(requester).sort().join(',') !==
      'agentId,channel,configPath,connectionId,credentialField,id,runtimeAccountId' ||
    parts.some((part) => typeof part !== 'string' || part.length === 0 || part.includes('\0')) ||
    !UUID.test(requester.connectionId) ||
    (requester.channel !== 'discord' && requester.channel !== 'telegram') ||
    !RUNTIME_ID.test(requester.runtimeAccountId) ||
    !RUNTIME_ID.test(requester.agentId) ||
    requester.credentialField !== expectedField ||
    requester.configPath !== expectedPath
  ) {
    throw new Error('invalid requester');
  }
  return parts;
}

function canonicalProofInput({ challenge, processInstanceId, requesters }) {
  if (
    !B64URL_32.test(challenge) ||
    !UUID.test(processInstanceId) ||
    !Array.isArray(requesters) ||
    requesters.length < 1 ||
    requesters.length > 128
  ) {
    throw new Error('invalid proof input');
  }
  const parts = [REQUESTER_DOMAIN, challenge, processInstanceId];
  const ids = new Set();
  for (const requester of requesters) {
    if (ids.has(requester?.id)) throw new Error('duplicate requester');
    ids.add(requester.id);
    parts.push(...canonicalRequester(requester));
  }
  return parts.join('\0');
}

function parseUpstreamRequest(raw) {
  const request = JSON.parse(raw);
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    request.protocolVersion !== 1 ||
    request.provider !== PROVIDER ||
    Object.keys(request).sort().join(',') !== 'ids,protocolVersion,provider,requesters' ||
    !Array.isArray(request.ids) ||
    !Array.isArray(request.requesters) ||
    request.ids.length < 1 ||
    request.ids.length > 128 ||
    request.requesters.length !== request.ids.length ||
    request.requesters.some((entry, index) => entry?.id !== request.ids[index])
  ) {
    throw new Error('invalid upstream request');
  }
  for (const requester of request.requesters) canonicalRequester(requester);
  return request;
}

function parseChallenge(raw) {
  const response = JSON.parse(raw);
  if (
    !response ||
    typeof response !== 'object' ||
    Array.isArray(response) ||
    Object.keys(response).sort().join(',') !== 'challenge,protocolVersion' ||
    response.protocolVersion !== PROTOCOL_VERSION ||
    !B64URL_32.test(response.challenge)
  ) {
    throw new Error('invalid challenge');
  }
  return response.challenge;
}

const socketPath = socketArgument(process.argv.slice(2));
let requesterKey;
let processInstanceId;
try {
  requesterKey = parseRequesterKey(process.env.EDEN_CHANNEL_REQUESTER_KEY);
  processInstanceId = process.env.EDEN_CHANNEL_REQUESTER_INSTANCE_ID?.trim();
  if (!UUID.test(processInstanceId ?? '')) throw new Error('invalid process instance');
} catch {
  requesterKey = null;
}

if (!socketPath || !requesterKey) {
  fail();
} else {
  const requestChunks = [];
  let requestBytes = 0;
  let rejected = false;

  process.stdin.on('data', (chunk) => {
    requestBytes += chunk.length;
    if (requestBytes > MAX_FRAME_BYTES) {
      rejected = true;
      process.stdin.pause();
      fail();
      return;
    }
    requestChunks.push(chunk);
  });

  process.stdin.on('error', () => fail());
  process.stdin.on('end', () => {
    if (rejected || requestBytes === 0) {
      if (!rejected) fail();
      return;
    }

    let upstream;
    try {
      upstream = parseUpstreamRequest(Buffer.concat(requestChunks).toString('utf8'));
    } catch {
      fail();
      return;
    }

    const socket = net.createConnection({ path: socketPath });
    const responseChunks = [];
    let responseBytes = 0;
    let challengeBuffer = Buffer.alloc(0);
    let requestSent = false;
    let finished = false;

    const reject = () => {
      if (finished) return;
      finished = true;
      socket.destroy();
      fail();
    };

    socket.setTimeout(TIMEOUT_MS, reject);
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      if (!requestSent) {
        challengeBuffer = Buffer.concat([challengeBuffer, chunk]);
        if (challengeBuffer.length > 1024) return reject();
        const newline = challengeBuffer.indexOf(0x0a);
        if (newline === -1) return;
        try {
          const challenge = parseChallenge(challengeBuffer.subarray(0, newline).toString('utf8'));
          const proofInput = { challenge, processInstanceId, requesters: upstream.requesters };
          const proof = createHmac('sha256', requesterKey)
            .update(canonicalProofInput(proofInput), 'utf8')
            .digest('base64url');
          requestSent = true;
          socket.write(
            `${JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              provider: PROVIDER,
              ids: upstream.ids,
              requesters: upstream.requesters,
              challenge,
              processInstanceId,
              proof,
            })}\n`,
          );
          const remaining = challengeBuffer.subarray(newline + 1);
          if (remaining.length > 0) responseChunks.push(remaining);
        } catch {
          reject();
        }
        return;
      }
      responseBytes += chunk.length;
      if (responseBytes > MAX_FRAME_BYTES) return reject();
      responseChunks.push(chunk);
    });
    socket.on('end', () => {
      if (finished || !requestSent) return reject();
      try {
        const parsed = JSON.parse(Buffer.concat(responseChunks).toString('utf8'));
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          parsed.protocolVersion !== PROTOCOL_VERSION ||
          !parsed.values ||
          typeof parsed.values !== 'object' ||
          Array.isArray(parsed.values) ||
          Object.values(parsed.values).some((value) => typeof value !== 'string') ||
          (parsed.errors !== undefined &&
            (!parsed.errors ||
              typeof parsed.errors !== 'object' ||
              Array.isArray(parsed.errors) ||
              Object.values(parsed.errors).some((value) => typeof value !== 'string')))
        ) {
          return reject();
        }
        finished = true;
        process.stdout.write(
          `${JSON.stringify({
            protocolVersion: 1,
            values: parsed.values,
            ...(parsed.errors ? { errors: parsed.errors } : {}),
          })}\n`,
        );
      } catch {
        reject();
      }
    });
  });
}
