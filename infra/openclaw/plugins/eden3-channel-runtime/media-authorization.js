import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

const MEDIA_TOOLS = new Set(['image_generate', 'video_generate', 'music_generate', 'tts']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_VIDEO_REFERENCE_BYTES = 10 * 1024 * 1024;

function boundedString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function callKey(runId, toolCallId) {
  return `${runId}\0${toolCallId}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mediaAuthorizationBlockReason(error) {
  switch (error?.code) {
    case 'insufficient_manna':
      return 'Eden needs more manna for this media request.';
    case 'daily_cap':
    case 'rolling_cap':
      return 'Eden paused this media request to protect the account manna budget.';
    case 'media_already_pending':
      return 'Another media generation is already in progress for this conversation.';
    case 'session_agent_binding':
      return 'This conversation is no longer authorized to generate media with this agent.';
    case 'unsupported_image_argument':
    case 'unsupported_image_aspect_ratio':
    case 'unsupported_image_size':
    case 'ambiguous_image_geometry':
    case 'unsupported_image_output_format':
    case 'invalid_image_count':
      return 'The requested media options are not supported.';
    case 'ticket_consumed':
      return 'This media request was already processed.';
    default:
      return 'Eden could not authorize this media generation.';
  }
}

function generatedVideoImageReference(params, stateDir) {
  if (params?.image !== undefined && params?.images !== undefined) return null;
  const raw = params?.image ?? params?.images;
  const value = Array.isArray(raw)
    ? raw.length === 1 && typeof raw[0] === 'string'
      ? raw[0]
      : null
    : typeof raw === 'string'
      ? raw
      : raw === undefined
        ? undefined
        : null;
  if (value === undefined) return undefined;
  if (value === null || !path.isAbsolute(value)) return null;
  const trustedRoot = path.resolve(stateDir, 'media', 'tool-image-generation');
  const resolved = path.resolve(value);
  if (
    resolved === trustedRoot ||
    !resolved.startsWith(`${trustedRoot}${path.sep}`) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,239}\.(?:png|jpe?g|webp)$/i.test(path.basename(resolved))
  ) {
    return null;
  }
  return resolved;
}

function videoImageExtension(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return 'png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpg';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

async function stageGeneratedVideoImage(sourcePath, stateDir, agentId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(agentId)) {
    throw new Error('invalid media agent identity');
  }
  const trustedRoot = path.resolve(stateDir, 'media', 'tool-image-generation');
  if ((await realpath(path.dirname(sourcePath))) !== (await realpath(trustedRoot))) {
    throw new Error('generated media root identity changed');
  }
  const source = await open(
    sourcePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  let bytes;
  try {
    const stat = await source.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_VIDEO_REFERENCE_BYTES) {
      throw new Error('generated media file is invalid');
    }
    bytes = await source.readFile();
    if (bytes.length !== stat.size) throw new Error('generated media file changed while reading');
  } finally {
    await source.close();
  }
  const extension = videoImageExtension(bytes);
  if (!extension) throw new Error('generated media type is unsupported');

  const workspace = path.resolve(stateDir, `workspace-${agentId}`);
  const stateRoot = await realpath(stateDir);
  const workspaceRoot = await realpath(workspace);
  if (workspaceRoot !== path.join(stateRoot, `workspace-${agentId}`)) {
    throw new Error('agent workspace identity is invalid');
  }
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 20);
  const stagedPath = path.join(
    workspaceRoot,
    `.eden-video-input-${digest}-${randomUUID()}.${extension}`,
  );
  const staged = await open(
    stagedPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await staged.writeFile(bytes);
    await staged.datasync();
  } catch (error) {
    await staged.close().catch(() => {});
    await unlink(stagedPath).catch(() => {});
    throw error;
  }
  await staged.close();
  return stagedPath;
}

export function createMediaAuthorizationBridge(options) {
  const client = options.client;
  const stateDir = options.stateDir ?? process.env.OPENCLAW_STATE_DIR ?? '/home/node/.openclaw';
  const admitting = new Set();
  const pending = new Map();
  const studioPending = new Set();
  const stagedVideoImages = new Map();

  async function onBeforeToolCall(event, ctx) {
    if (!MEDIA_TOOLS.has(event?.toolName)) return;
    // Catalog/status requests spend no provider money. Generation is the only
    // action authorized by this M3 callback.
    if (event?.params?.action && event.params.action !== 'generate') return;
    const runId = boundedString(event?.runId ?? ctx?.runId, 200);
    const toolCallId = boundedString(event?.toolCallId ?? ctx?.toolCallId, 200);
    const sessionKey = boundedString(ctx?.sessionKey, 1_000);
    const agentId = boundedString(ctx?.agentId, 200);
    if (!sessionKey || !agentId) {
      return { block: true, blockReason: 'Eden media authorization context unavailable.' };
    }
    const videoImage =
      event.toolName === 'video_generate'
        ? generatedVideoImageReference(event.params, stateDir)
        : undefined;
    if (event.toolName === 'video_generate') {
      if (videoImage === null) {
        return { block: true, blockReason: 'Eden rejected the video reference image.' };
      }
      if (videoImage) {
        event = { ...event, params: { ...event.params, image: videoImage } };
      }
    }
    const key =
      runId && toolCallId ? callKey(runId, toolCallId) : callKey(sessionKey, event.toolName);
    if (admitting.has(key) || pending.has(key) || studioPending.has(key)) {
      return { block: true, blockReason: 'Eden media generation is already in progress.' };
    }
    admitting.add(key);
    let stagedVideoImage;
    try {
      if (videoImage) {
        stagedVideoImage = await stageGeneratedVideoImage(videoImage, stateDir, agentId);
      }
      const response = await client.post('/media/runtime/authorizations', {
        ...(runId ? { runId } : {}),
        ...(toolCallId ? { toolCallId } : {}),
        sessionKey,
        agentId,
        tool: event.toolName,
        args: event.params ?? {},
      });
      if (
        !UUID.test(response?.authorizationId ?? '') ||
        response?.tool !== event.toolName ||
        !['chat', 'studio'].includes(response?.authorizationOwner) ||
        !isPlainObject(response?.providerArgs) ||
        !Number.isSafeInteger(response?.authorizedMaxManna) ||
        response.authorizedMaxManna <= 0
      ) {
        throw new Error('invalid media authorization response');
      }
      if (
        videoImage &&
        (response.providerArgs.image !== videoImage ||
          response.providerArgs.model !== 'fal/fal-ai/kling-video/v3/pro/image-to-video')
      ) {
        throw new Error('invalid image-to-video authorization response');
      }
      const providerArgs = stagedVideoImage
        ? { ...response.providerArgs, image: stagedVideoImage }
        : response.providerArgs;
      if (stagedVideoImage) stagedVideoImages.set(key, stagedVideoImage);
      if (response.authorizationOwner === 'studio') {
        studioPending.add(key);
        return { params: providerArgs };
      }
      if (!runId || !toolCallId) {
        throw new Error('chat media authorization lacks durable host identity');
      }
      pending.set(key, response.authorizationId.toLowerCase());
      return { params: providerArgs };
    } catch (error) {
      if (stagedVideoImage) await unlink(stagedVideoImage).catch(() => {});
      return { block: true, blockReason: mediaAuthorizationBlockReason(error) };
    } finally {
      admitting.delete(key);
    }
  }

  async function onAfterToolCall(event, ctx) {
    if (!MEDIA_TOOLS.has(event?.toolName)) return;
    const runId = boundedString(event?.runId ?? ctx?.runId, 200);
    const toolCallId = boundedString(event?.toolCallId ?? ctx?.toolCallId, 200);
    const sessionKey = boundedString(ctx?.sessionKey, 1_000);
    const key =
      runId && toolCallId
        ? callKey(runId, toolCallId)
        : sessionKey
          ? callKey(sessionKey, event.toolName)
          : null;
    if (!key) return;
    const stagedVideoImage = stagedVideoImages.get(key);
    stagedVideoImages.delete(key);
    if (stagedVideoImage) await unlink(stagedVideoImage).catch(() => {});
    if (studioPending.delete(key)) return;
    const authorizationId = pending.get(key);
    pending.delete(key);
    if (!authorizationId) return;
    const result = event?.result;
    const failed =
      typeof event?.error === 'string' ||
      (result && typeof result === 'object' && (result.isError === true || result.ok === false));
    if (!failed) return;
    try {
      await client.post(`/media/runtime/authorizations/${authorizationId}/fail`, {
        errorCode: 'media_tool_failed',
      });
    } catch {
      // Durable refund_pending/reaper recovery is provider-free backstop.
    }
  }

  return Object.freeze({ onBeforeToolCall, onAfterToolCall });
}
