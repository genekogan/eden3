import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Global error envelope. Every non-2xx JSON response the API produces has
 * this exact shape (route errors, 404s, 501 stubs, thrown ApiErrors).
 */
export interface ErrorEnvelope {
  error: {
    /** Machine-readable code, e.g. "not_found", "unauthorized", "internal_error". */
    code: string;
    message: string;
    statusCode: number;
  };
}

export function errorEnvelope(statusCode: number, code: string, message: string): ErrorEnvelope {
  return { error: { code, message, statusCode } };
}

/** Throwable error carrying its HTTP status + envelope code. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Send an error envelope on `reply` (for handlers that reply directly). */
export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(statusCode).send(errorEnvelope(statusCode, code, message));
}

/**
 * Handler factory for skeleton route stubs: responds 501 with the envelope.
 * TODO(W2): every stub using this is replaced by a real implementation.
 */
export function notImplemented(area: string) {
  return async (_req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
    sendError(reply, 501, 'not_implemented', `${area} API is not implemented yet (W1 skeleton stub)`);
}
