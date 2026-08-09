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

const PUBLIC_SERVER_ERROR_MESSAGES = new Map<number, string>([
  [500, 'Internal server error'],
  [502, 'Upstream service unavailable'],
  [504, 'Request timed out'],
]);
const PUBLIC_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Server failures may contain database, provider, filesystem, or credential
 * detail. Status and machine code remain public; unreviewed 5xx text never is.
 */
export function publicErrorMessage(statusCode: number, message: string): string {
  if (statusCode < 500) {
    return message;
  }
  return PUBLIC_SERVER_ERROR_MESSAGES.get(statusCode) ?? 'Service temporarily unavailable';
}

export function publicErrorCode(statusCode: number, code: string): string {
  if (statusCode < 500 || PUBLIC_ERROR_CODE.test(code)) {
    return code;
  }
  return 'internal_error';
}

export function errorEnvelope(statusCode: number, code: string, message: string): ErrorEnvelope {
  return {
    error: {
      code: publicErrorCode(statusCode, code),
      message: publicErrorMessage(statusCode, message),
      statusCode,
    },
  };
}

const SAFE_ERROR_NAMES = new Set([
  'AggregateError',
  'ApiError',
  'Error',
  'GatewayHttpError',
  'GatewayToolError',
  'MediaClaimTimeoutError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'ZodError',
]);
const SAFE_ERROR_CODE = /^(?:E[A-Z0-9_]{1,31}|FST_ERR_[A-Z0-9_]{1,48})$/;

/**
 * Retain useful HTTP-boundary telemetry without serializing an exception's
 * untrusted message, stack, cause, provider body, query, or credential data.
 * Background workers keep their existing richer logging policy.
 */
export function safeServerErrorLog(error: unknown): {
  errorName: string;
  errorCode?: string | number;
} {
  const candidateName = error instanceof Error ? error.name : typeof error;
  const errorName = SAFE_ERROR_NAMES.has(candidateName) ? candidateName : 'Error';
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return { errorName };
  }
  const candidateCode = (error as { code?: unknown }).code;
  if (typeof candidateCode === 'number' && Number.isSafeInteger(candidateCode)) {
    return { errorName, errorCode: candidateCode };
  }
  if (typeof candidateCode === 'string' && SAFE_ERROR_CODE.test(candidateCode)) {
    return { errorName, errorCode: candidateCode };
  }
  return { errorName };
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
