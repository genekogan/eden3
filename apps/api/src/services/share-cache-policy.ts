import type { FastifyReply } from 'fastify';

export const PRIVATE_CAPABILITY_CACHE_CONTROL =
  'private, no-store, no-cache, max-age=0, must-revalidate';

/** Apply before parsing/resolution so denials and thrown errors inherit it. */
export function applyPrivateCapabilityHeaders(reply: FastifyReply): void {
  reply.header('cache-control', PRIVATE_CAPABILITY_CACHE_CONTROL);
  reply.header('cdn-cache-control', 'no-store');
  reply.header('surrogate-control', 'no-store');
  reply.header('pragma', 'no-cache');
  reply.header('expires', '0');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-robots-tag', 'noindex, nofollow, noarchive');
}
