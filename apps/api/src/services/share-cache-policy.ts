import type { FastifyInstance, FastifyReply } from 'fastify';

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

/** Boundary-only predicate. It marks responses and never grants admission. */
export function isShareCapabilityRequest(rawUrl: string): boolean {
  const path = rawUrl.split('?', 1)[0] ?? '';
  return path.startsWith('/shares/') || path.startsWith('/media/share/');
}

export function isRuntimeVoiceCapabilityRequest(rawUrl: string): boolean {
  const path = rawUrl.split('?', 1)[0] ?? '';
  return path.startsWith('/media/runtime/voice/');
}

export function isPrivateCapabilityRequest(rawUrl: string): boolean {
  return isShareCapabilityRequest(rawUrl) || isRuntimeVoiceCapabilityRequest(rawUrl);
}

export function redactedRequestUrl(rawUrl: string): string {
  if (rawUrl.startsWith('/shares/')) return '/shares/[redacted]';
  if (rawUrl.startsWith('/media/share/')) return '/media/share/[redacted]';
  if (rawUrl.startsWith('/media/runtime/voice/')) return '/media/runtime/voice/[redacted]';
  return rawUrl;
}

/** Register before hardening/auth so their early denials inherit no-store. */
export function registerShareCapabilityResponseBoundary(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (isPrivateCapabilityRequest(request.url)) applyPrivateCapabilityHeaders(reply);
  });
}

export function safeNotFoundMessage(method: string, rawUrl: string): string {
  if (isShareCapabilityRequest(rawUrl)) return 'Share capability not found';
  if (isRuntimeVoiceCapabilityRequest(rawUrl)) return 'Voice capability not found';
  return `Route ${method} ${rawUrl} not found`;
}

export function safeCapabilityErrorMessage(rawUrl: string, message: string): string {
  if (isShareCapabilityRequest(rawUrl)) return 'Share capability request failed';
  if (isRuntimeVoiceCapabilityRequest(rawUrl)) return 'Voice capability request failed';
  return message;
}
