import { createReadStream } from 'node:fs';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../errors';
import type { MediaObjectResolver } from '../services/media-object-repository';
import { hashSessionShareToken } from '../services/session-shares';
import { applyPrivateCapabilityHeaders } from '../services/share-cache-policy';

export interface MediaObjectRoutesOptions {
  resolver: MediaObjectResolver;
}

const paramsSchema = z.object({ objectId: z.string().uuid() });
const shareParamsSchema = paramsSchema.extend({
  token: z.string().regex(/^[A-Za-z0-9_-]{32,200}$/),
});
const objectRoute =
  '/media/:objectId(^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$)';
const sharedObjectRoute =
  '/media/share/:token/:objectId(^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$)';

interface ByteRange {
  start: number;
  end: number;
}

function parseRange(value: string | undefined, size: number): ByteRange | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size === 0) throw new ApiError(416, 'invalid_range', 'Requested range is not satisfiable');
  const [, startText, endText] = match;
  let start: number;
  let end: number;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new ApiError(416, 'invalid_range', 'Requested range is not satisfiable');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new ApiError(416, 'invalid_range', 'Requested range is not satisfiable');
    end = Math.min(end, size - 1);
  }
  if (start < 0 || start >= size || end < start) throw new ApiError(416, 'invalid_range', 'Requested range is not satisfiable');
  return { start, end };
}

export const mediaObjectRoutes: FastifyPluginAsync<MediaObjectRoutesOptions> = async (app, options) => {
  const handle = async (request: FastifyRequest, reply: FastifyReply) => {
    const rawParams = request.params as Record<string, unknown>;
    const sharedRequest = typeof rawParams.token === 'string';
    if (sharedRequest) applyPrivateCapabilityHeaders(reply);
    const { objectId } = paramsSchema.parse(request.params);
    const sharedParams = sharedRequest ? shareParamsSchema.safeParse(rawParams) : null;
    if (sharedRequest && !sharedParams?.success) {
      throw new ApiError(404, 'media_object_not_found', 'Media object not found');
    }
    const shareTokenHash = sharedParams?.success
      ? hashSessionShareToken(sharedParams.data.token)
      : null;
    const resolved = await options.resolver.resolve(
      objectId,
      request.account?.accountId ?? null,
      shareTokenHash,
      sharedRequest,
    );
    reply.header('accept-ranges', 'bytes');
    reply.header('content-type', resolved.mime);
    reply.header('etag', `"${resolved.sha256}"`);
    if (!sharedRequest) {
      reply.header(
        'cache-control',
        resolved.publiclyReferenced ? 'public, max-age=31536000, immutable' : 'private, no-store',
      );
    }
    const rawRange = request.headers.range;
    const range = parseRange(Array.isArray(rawRange) ? rawRange[0] : rawRange, resolved.sizeBytes);
    if (request.method === 'HEAD') {
      reply.header('content-length', String(range ? range.end - range.start + 1 : resolved.sizeBytes));
      if (range) {
        reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${resolved.sizeBytes}`);
      }
      return reply.send();
    }

    const hydrated = await options.resolver.hydrator.hydrate(resolved.storedObject, {
      displayName: resolved.displayName,
    });
    const stream = createReadStream(hydrated.localPath, range ?? undefined);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      void hydrated.release();
    };
    stream.once('end', release);
    stream.once('close', release);
    stream.once('error', release);
    if (range) {
      reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${resolved.sizeBytes}`);
      reply.header('content-length', String(range.end - range.start + 1));
    } else {
      reply.header('content-length', String(resolved.sizeBytes));
    }
    return reply.send(stream);
  };

  app.get(sharedObjectRoute, { exposeHeadRoute: false }, handle);
  app.head(sharedObjectRoute, handle);
  app.get(objectRoute, { exposeHeadRoute: false }, handle);
  app.head(objectRoute, handle);
};
