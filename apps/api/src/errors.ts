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
const PUBLIC_SERVER_ERROR_CODES = new Set([
  'account_erasure_unavailable',
  'agent_provision_failed',
  'backend_part_size_mismatch',
  'channel_custody_unavailable',
  'configuration_error',
  'database_unavailable',
  'erasure_intent_mismatch',
  'erasure_ledger_mismatch',
  'erasure_ledger_unavailable',
  'erasure_recovery_manifest_mismatch',
  'erasure_recovery_manifest_unavailable',
  'gateway_error',
  'gateway_not_configured',
  'gateway_stream_error',
  'gateway_unavailable',
  'gateway_unconfigured',
  'generation_timeout',
  'internal_error',
  'managed_bot_activation_failed',
  'managed_bot_revocation_failed',
  'managed_bot_state_unavailable',
  'media_refund_pending',
  'memory_scheduler_unavailable',
  'metering_not_configured',
  'not_implemented',
  'provider_error',
  'provider_unavailable',
  'refund_pending',
  'repair_failed',
  'scheduled_task_checkpointed_failure',
  'scheduled_task_empty_response',
  'scheduled_task_error',
  'scheduled_task_occurrence_indeterminate',
  'scheduled_task_occurrence_refund_pending',
  'secret_vault_not_configured',
  'skill_sync_failed',
  'stripe_checkout_failed',
  'stripe_not_configured',
  'stripe_price_not_configured',
  'subscription_runtime_unavailable',
  'telegram_manager_not_configured',
  'telegram_response_invalid',
  'telegram_unavailable',
  'turn_capacity_exceeded',
  'turn_queue_timeout',
  'tts_not_configured',
]);

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
  if (statusCode < 500 || PUBLIC_SERVER_ERROR_CODES.has(code)) {
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

/**
 * Retain useful HTTP-boundary telemetry without serializing an exception's
 * untrusted message, stack, cause, provider body, query, or credential data.
 * Background workers keep their existing richer logging policy.
 */
export function safeServerErrorLog(error: unknown): {
  errorName: string;
} {
  const candidateName = error instanceof Error ? error.name : typeof error;
  const errorName = SAFE_ERROR_NAMES.has(candidateName) ? candidateName : 'Error';
  return { errorName };
}

interface RequestErrorLogger {
  error(context: Record<string, unknown>, message: string): unknown;
  warn(context: Record<string, unknown>, message: string): unknown;
}

function logSafeRequestFailure(
  logger: RequestErrorLogger,
  level: 'error' | 'warn',
  error: unknown,
  context: Record<string, unknown>,
  message: string,
): void {
  logger[level]({ ...context, ...safeServerErrorLog(error) }, message);
}

/** Runtime-capturable request logging seams that never serialize throwables. */
export function logSafeRequestError(
  logger: RequestErrorLogger,
  error: unknown,
  context: Record<string, unknown>,
  message: string,
): void {
  logSafeRequestFailure(logger, 'error', error, context, message);
}

export function logSafeRequestWarning(
  logger: RequestErrorLogger,
  error: unknown,
  context: Record<string, unknown>,
  message: string,
): void {
  logSafeRequestFailure(logger, 'warn', error, context, message);
}

export function safeRequestErrorCallback(
  logger: RequestErrorLogger,
  context: Record<string, unknown>,
  message: string,
  level: 'error' | 'warn' = 'error',
): (error: unknown) => void {
  return (error) => logSafeRequestFailure(logger, level, error, context, message);
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
