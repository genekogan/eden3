import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

import { getEnv } from '@eden3/core';
import { db, pg, type SchemaReadiness } from '@eden3/db';
import { OpenClawCompatClient, OpenClawToolsClient } from '@eden3/gateway';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { ZodError } from 'zod';

import {
  authenticateServiceCallbackRequest,
  isAuthenticatedServiceCallbackRequest,
  isServiceAuthenticatedCallbackRequest,
  registerAuth,
  type AuthPluginOptions,
} from './auth-plugin';
import {
  ApiError,
  errorEnvelope,
  logSafeRequestError,
  publicErrorCode,
  publicErrorMessage,
} from './errors';
import { EventsBus, sessionEventsRoutes } from './events-bus';
import { GatewayGlue, defaultOpenclawDataDir, type GatewayGlueOptions } from './gateway-glue';
import { TurnConcurrencyLimiter } from './services/chat-limits';
import { ensureBuiltinSkills } from './services/agent-skills';
import { ensureEveAssistant } from './services/default-assistant';
import {
  registerAccountRateLimiting,
  registerHttpHardening,
} from './services/http-hardening';
import { HistorySync, type AttachmentCallback, type ToolsClientLike } from './services/history-sync';
import { AgentProvisioningWorker } from './services/agent-provisioning';
import { AgentRuntimeSyncScheduler } from './services/agent-runtime-sync';
import { startBackgroundWorkerLoop } from './services/background-worker-loop';
import {
  accountErasureIntervalMs,
  assertAccountErasureRuntimeComposition,
  assertAccountErasureRuntimeDatabaseIdentity,
  registerAccountErasureBackgroundLifecycle,
  type AccountErasureRuntimeBundle,
} from './services/account-erasure-runtime';
import { MediaPipeline, type AttachmentKind } from './services/media-pipeline';
import { legacyMediaIsPubliclyReachable } from './services/legacy-media-visibility';
import type { RuntimeAttestation } from './services/runtime-attestation';
import {
  EdenMemoryDreamAgentRunner,
  MemoryDreamOrchestrator,
  MemoryDreamScheduler,
  PostgresMemoryDreamStore,
} from './services/memory-dreaming';
import {
  makeScheduledTaskRecoveryRunner,
  makeScheduledTaskRunner,
  TaskScheduler,
} from './services/task-scheduler';
import { TurnRegistry } from './services/turn-registry';
import { TurnReservationReaper } from './services/turn-reservation-reaper';
import {
  isStudioOutputKindQuarantined,
  StudioReservationReaper,
} from './services/studio-reservations';
import { ChatMediaReservationReaper } from './services/chat-media-authorization';
import type { SessionShareRepository } from './services/session-shares';
import { PostgresSessionShareRepository } from './services/session-shares-postgres';
import type { CompatClientLike } from './services/turns';
import { createAttachmentSightingHandler, MediaWatcher } from './workers/media-watcher';
import { accountRoutes } from './routes/account';
import { agentsRoutes } from './routes/agents';
import { authRoutes } from './routes/auth';
import { billingRoutes, type BillingRoutesOptions } from './routes/billing';
import { chatRoutes } from './routes/chat';
import { channelsRoutes, type ChannelsRoutesOptions } from './routes/channels';
import { collectionsRoutes } from './routes/collections';
import { conceptsRoutes } from './routes/concepts';
import { creationsRoutes } from './routes/creations';
import { devRoutes } from './routes/dev';
import { feedRoutes } from './routes/feed';
import { mannaRoutes } from './routes/manna';
import { mediaObjectRoutes } from './routes/media-objects';
import { mediaRuntimeRoutes } from './routes/media-runtime';
import { notificationsRoutes, type NotificationsRoutesOptions } from './routes/notifications';
import { operatorRoutes } from './routes/operator';
import { searchRoutes } from './routes/search';
import { sessionShareRoutes } from './routes/session-shares';
import { sessionsRoutes } from './routes/sessions';
import { skillsRoutes } from './routes/skills';
import { studioRoutes } from './routes/studio';
import { triggersRoutes } from './routes/triggers';
import { usageRoutes } from './routes/usage';
import { workspaceRoutes } from './routes/workspace';
import { uploadsRoutes } from './routes/uploads';
import {
  createStorageRuntime,
  storageCleanupIntervalMs,
  storagePolicyIntervalMs,
  type StorageRuntime,
} from './services/storage-runtime';
import type { MultipartCleanupTickResult } from './services/upload-multipart-cleanup';
import type { PolicyEventTickResult } from './services/upload-policy-events';
import {
  isShareCapabilityRequest,
  registerShareCapabilityResponseBoundary,
  safeCapabilityErrorMessage,
  safeNotFoundMessage,
} from './services/share-cache-policy';

const requireCjs = createRequire(import.meta.url);
const pkg = requireCjs('../package.json') as { version: string };

export interface BuildServerOptions {
  /** Fastify logger config; defaults to false (quiet — tests/inject). */
  logger?: FastifyServerOptions['logger'];
  auth?: AuthPluginOptions;
  /**
   * Gateway client overrides (tests). Default: real OpenClaw clients when
   * OPENCLAW_GATEWAY_TOKEN is configured, otherwise null (chat answers 503).
   */
  gateway?: { compat: CompatClientLike; tools: ToolsClientLike } | null;
  /**
   * Agent-provisioning/cron-sync overrides (tests inject fakes). Default:
   * real AgentProvisioner + CronSync, constructed lazily on first use
   * (see gateway-glue.ts).
   */
  provisioning?: GatewayGlueOptions;
  /** Async agent-build worker timing overrides for deterministic tests. */
  agentProvisioning?: {
    intervalMs?: number;
    leaseMs?: number;
    retryMs?: number;
    maxAttempts?: number;
    batchSize?: number;
  };
  /**
   * Media-pipeline hook: called for every `MEDIA:`/`Attachment:` line
   * history-sync finds in a gateway transcript (see services/history-sync).
   * The media watcher wires this; may also be set later via
   * `app.historySync?.setAttachmentCallback`.
   */
  onAttachment?: AttachmentCallback;
  media?: {
    /**
     * Start the shared media watcher during server boot. Entrypoints should
     * enable this; unit tests usually leave it false and let Studio start the
     * watcher only when a generation is requested.
     */
    autoStartWatcher?: boolean;
  };
  billing?: BillingRoutesOptions;
  channels?: ChannelsRoutesOptions;
  health?: {
    /** Production schema gate; tests may inject deterministic readiness. */
    schemaReadiness?: () => Promise<SchemaReadiness>;
    /** Closed E2E process-identity proof; absent from ordinary responses. */
    runtimeAttestation?: RuntimeAttestation;
  };
  storage?: {
    /** Construct the production object/upload runtime. Tests leave this false. */
    enabled?: boolean;
    /** Fully injected runtime for narrow route/server tests. */
    runtime?: StorageRuntime;
    /** Run the durable quarantine outbox loop; production entrypoints enable it. */
    autoStartPolicyWorker?: boolean;
  };
  scheduler?: {
    /**
     * Start the scheduled-task loop during server boot. Entrypoints should
     * enable this; tests leave it off and drive `app.taskScheduler.tick()`
     * (or their own TaskScheduler) directly.
     */
    autoStart?: boolean;
  };
  shares?: { repository: SessionShareRepository };
  notifications?: NotificationsRoutesOptions;
  accountErasure?: AccountErasureRuntimeBundle;
  /** Deterministic DB-free startup seams; production always uses the defaults. */
  bootstrap?: {
    ensureBuiltinSkills: typeof ensureBuiltinSkills;
    ensureEveAssistant: typeof ensureEveAssistant;
  };
}

const SAFE_HEALTH_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isCount(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

/** A narrowly reviewed operational 503 body, with no free-form failure text. */
export function isSafeHealthReadinessResponse(requestUrl: string, payload: unknown): boolean {
  if (requestUrl.split('?', 1)[0] !== '/health' || !isRecord(payload)) {
    return false;
  }
  if (!hasOnlyKeys(payload, ['ok', 'versions', 'database', 'schema'])) {
    return false;
  }
  if (payload.ok !== false || !isRecord(payload.versions) || !isRecord(payload.schema)) {
    return false;
  }
  const versions = payload.versions;
  const schema = payload.schema;
  if (!hasOnlyKeys(versions, ['api', 'node', 'fastify'])) {
    return false;
  }
  if (
    !['api', 'node', 'fastify'].every(
      (key) => typeof versions[key] === 'string' && SAFE_HEALTH_IDENTIFIER.test(versions[key]),
    )
  ) {
    return false;
  }
  if (
    payload.database !== null &&
    (typeof payload.database !== 'string' || !SAFE_HEALTH_IDENTIFIER.test(payload.database))
  ) {
    return false;
  }
  if (
    !hasOnlyKeys(schema, [
      'status',
      'expectedMigration',
      'expectedCount',
      'appliedCount',
      'missingCount',
      'unexpectedCount',
    ])
  ) {
    return false;
  }
  if (
    typeof schema.status !== 'string' ||
    ![
      'missing_migrations',
      'unexpected_migrations',
      'database_unavailable',
      'unchecked',
    ].includes(schema.status)
  ) {
    return false;
  }
  if (
    schema.expectedMigration !== null &&
    (typeof schema.expectedMigration !== 'string' ||
      !SAFE_HEALTH_IDENTIFIER.test(schema.expectedMigration))
  ) {
    return false;
  }
  return [
    schema.expectedCount,
    schema.appliedCount,
    schema.missingCount,
    schema.unexpectedCount,
  ].every(isCount);
}

function isCanonicalServerError(payload: unknown, statusCode: number): boolean {
  if (!isRecord(payload) || !hasOnlyKeys(payload, ['error']) || !isRecord(payload.error)) {
    return false;
  }
  if (!hasOnlyKeys(payload.error, ['code', 'message', 'statusCode'])) {
    return false;
  }
  return typeof payload.error.code === 'string' &&
    publicErrorCode(statusCode, payload.error.code) === payload.error.code &&
    payload.error.statusCode === statusCode &&
    payload.error.message === publicErrorMessage(statusCode, '');
}

export function registerApiErrorHandler(
  app: FastifyInstance,
  options: { bodyLimitBytes: number },
): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode < 500) return payload;
    let decoded: unknown = payload;
    if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
      try {
        decoded = JSON.parse(payload.toString());
      } catch {
        decoded = null;
      }
    }
    if (
      isSafeHealthReadinessResponse(request.url, decoded) ||
      isCanonicalServerError(decoded, reply.statusCode)
    ) {
      return payload;
    }
    const candidate =
      decoded && typeof decoded === 'object' &&
      'error' in decoded && decoded.error && typeof decoded.error === 'object' &&
      'code' in decoded.error
        ? decoded.error.code
        : null;
    const code = publicErrorCode(
      reply.statusCode,
      typeof candidate === 'string' ? candidate : 'internal_error',
    );
    for (const header of [
      'accept-ranges',
      'content-encoding',
      'content-length',
      'content-range',
      'digest',
      'etag',
      'last-modified',
    ]) {
      reply.removeHeader(header);
    }
    reply.header('content-type', 'application/json; charset=utf-8');
    return JSON.stringify(errorEnvelope(reply.statusCode, code, ''));
  });

  app.setErrorHandler<FastifyError | ApiError | ZodError>((err, req, reply) => {
    let statusCode: number;
    let code: string;
    let message: string;
    if (err instanceof ApiError) {
      ({ statusCode, code, message } = err);
    } else if (err instanceof ZodError) {
      statusCode = 400;
      code = 'bad_request';
      message = err.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
    } else if (
      err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ||
      (typeof err.statusCode === 'number' && err.statusCode === 413)
    ) {
      statusCode = 413;
      code = 'payload_too_large';
      message = `Request body exceeds ${options.bodyLimitBytes} bytes`;
    } else {
      statusCode =
        typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
      code = statusCode >= 500 ? 'internal_error' : (err.code ?? 'bad_request');
      message = err.message || 'Internal server error';
    }
    code = publicErrorCode(statusCode, code);
    const capabilityRequest = isShareCapabilityRequest(req.url);
    if (statusCode >= 500) {
      logSafeRequestError(
        req.log,
        err,
        { requestId: req.id, statusCode, code },
        capabilityRequest ? 'share capability request failed' : 'request failed',
      );
    }
    void reply
      .code(statusCode)
      .send(errorEnvelope(statusCode, code, safeCapabilityErrorMessage(req.url, message)));
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Media-correlation registry of recently-active chat turns. */
    turnRegistry: TurnRegistry;
    /** Gateway transcript sync (null when the gateway is not configured). */
    historySync: HistorySync | null;
    /** Streaming chat client (null when the gateway is not configured). */
    gatewayCompat: CompatClientLike | null;
    /** Per-process in-flight chat turn limiter. */
    turnLimiter: TurnConcurrencyLimiter;
    /** Eden3-side scheduled-task loop (null when the gateway is not configured). */
    taskScheduler: TaskScheduler | null;
    /** Orphaned turn-reservation compensation loop (T08-U02). */
    turnReservationReaper: TurnReservationReaper;
    /** Orphaned Studio generation compensation loop (DEBT-010). */
    studioReservationReaper: StudioReservationReaper;
    /** Orphaned in-chat media compensation loop (DEBT-007). */
    chatMediaReservationReaper: ChatMediaReservationReaper;
    /** Eden-managed, activity-gated native deep + metered REM loop. */
    memoryDreamScheduler: MemoryDreamScheduler | null;
    /** Durable, fenced async agent-build worker (tests may drive tick()). */
    agentProvisioningWorker: AgentProvisioningWorker;
  }
}

/**
 * Build the eden3 API server (not yet listening — callers `listen()` or
 * `inject()`). Env is read via @eden3/core `getEnv()`; entrypoints must have
 * populated process.env first (loadRootEnv).
 */
export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  assertAccountErasureRuntimeComposition(opts.accountErasure);
  assertAccountErasureRuntimeDatabaseIdentity(opts.accountErasure, { db, pg });
  const env = getEnv();

  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: env.API_BODY_LIMIT_BYTES,
    disableRequestLogging: true, // replaced by structured redacted logging below
    forceCloseConnections: true, // don't let open SSE sockets block close()
    // Caddy is the only production ingress and reaches the API on loopback.
    // Trust no forwarding header from a non-loopback immediate peer.
    trustProxy: (address) =>
      address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1',
  });

  // Capability URLs carry bearer material in their path. Mark them before
  // rate limiting, auth, cohort admission, routing, and parsing can terminate
  // the request. This hook changes response policy only; admission remains
  // exclusively owned by auth-plugin's exact method/path rules.
  registerShareCapabilityResponseBoundary(app);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  // Structured request logging. Deliberately no headers/body/cookies/auth.
  if (opts.logger) {
    app.addHook('onResponse', async (req, reply) => {
      const requestSessionId = Array.isArray(req.headers['x-session-id'])
        ? req.headers['x-session-id'][0]
        : req.headers['x-session-id'];
      const responseSessionId = reply.getHeader('x-session-id');
      const sessionId =
        typeof responseSessionId === 'string'
          ? responseSessionId
          : typeof requestSessionId === 'string'
            ? requestSessionId
            : undefined;
      req.log.info(
        {
          requestId: req.id,
          method: req.method,
          url: req.url.startsWith('/shares/')
            ? '/shares/[redacted]'
            : req.url.startsWith('/media/share/')
              ? '/media/share/[redacted]'
              : req.url,
          statusCode: reply.statusCode,
          elapsedMs: Number(reply.elapsedTime.toFixed(1)),
          ...(sessionId ? { sessionId } : {}),
        },
        'request completed',
      );
    });
  }

  // Global error envelope. Every 5xx crosses the fail-closed public-message
  // boundary before serialization, while the log retains only safe metadata.
  registerApiErrorHandler(app, { bodyLimitBytes: env.API_BODY_LIMIT_BYTES });

  app.setNotFoundHandler((req, reply) => {
    void reply
      .code(404)
      .send(errorEnvelope(404, 'not_found', safeNotFoundMessage(req.method, req.url)));
  });

  registerHttpHardening(app, {
    rateLimit: { windowMs: env.API_RATE_LIMIT_WINDOW_MS, max: env.API_RATE_LIMIT_MAX },
    serviceCallbackAdmission: async (request, reply) =>
      isServiceAuthenticatedCallbackRequest(request)
        ? authenticateServiceCallbackRequest(request, reply)
        : false,
  });

  await app.register(fastifyCors, {
    origin: [`http://localhost:${env.WEB_PORT}`, `http://127.0.0.1:${env.WEB_PORT}`],
    credentials: true,
    exposedHeaders: ['x-session-id'], // new-session hint on POST …/messages
  });

  // Creation URLs can legitimately use the API origin directly while the web
  // app is served from localhost (or a separate production hostname). Keep
  // the global API default `same-site`, but opt public media into embedding.
  // `onSend` is intentionally used instead of fastify-static's raw-response
  // callback so it wins over the earlier Fastify hardening header.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/media/')) {
      reply.header('cross-origin-resource-policy', 'cross-origin');
    }
    return payload;
  });

  // Which database this stack points at (ENV-1: the running stack may be the
  // staging mirror) — the UI labels stg vs the canonical fork so fixture data
  // is never mistaken for migrated data during evaluation. Name only, never
  // credentials.
  const databaseName = (() => {
    try {
      const url = new URL(process.env.DATABASE_URL ?? '');
      return url.pathname.replace(/^\//, '') || null;
    } catch {
      return null;
    }
  })();

  app.get('/health', async (request, reply) => {
    const requireSchema = request.url.includes('?') &&
      new URL(request.url, 'http://eden3.local').searchParams.get('ready') === '1';
    let schema: SchemaReadiness | {
      status: 'unchecked';
      expectedMigration: null;
      expectedCount: null;
      appliedCount: null;
      missingCount: null;
      unexpectedCount: null;
    };
    if (opts.health?.schemaReadiness) {
      try {
        schema = await opts.health.schemaReadiness();
      } catch {
        schema = {
          status: 'database_unavailable',
          expectedMigration: 'unknown',
          expectedCount: 0,
          appliedCount: null,
          missingCount: null,
          unexpectedCount: null,
        };
      }
    } else {
      schema = {
        status: 'unchecked',
        expectedMigration: null,
        expectedCount: null,
        appliedCount: null,
        missingCount: null,
        unexpectedCount: null,
      };
    }
    const ok = schema.status === 'ready' || (schema.status === 'unchecked' && !requireSchema);
    return reply.code(ok ? 200 : 503).send({
      ok,
      versions: { api: pkg.version, node: process.version, fastify: app.version },
      database: databaseName,
      schema,
      ...(ok && opts.health?.runtimeAttestation
        ? { runtimeAttestation: opts.health.runtimeAttestation }
        : {}),
    });
  });

  // Auth (request.account + app.requireAuth) — root scope, before routes.
  registerAuth(app, opts.auth);
  registerAccountRateLimiting(app, {
    rateLimit: {
      windowMs: env.API_ACCOUNT_RATE_LIMIT_WINDOW_MS,
      max: env.API_ACCOUNT_RATE_LIMIT_MAX,
    },
    bypass: isAuthenticatedServiceCallbackRequest,
  });

  // Per-session SSE bus + its endpoint (GET /sessions/:id/events).
  app.decorate('eventsBus', new EventsBus());
  await app.register(sessionEventsRoutes);

  // Gateway clients + chat-turn services. `gateway: null` (or a missing
  // token) leaves chat disabled with a 503 while the rest of the API works.
  const gatewayClients =
    opts.gateway !== undefined
      ? opts.gateway
      : env.OPENCLAW_GATEWAY_TOKEN
        ? {
            compat: new OpenClawCompatClient({
              baseUrl: env.OPENCLAW_BASE_URL,
              token: env.OPENCLAW_GATEWAY_TOKEN,
            }),
            tools: new OpenClawToolsClient({
              baseUrl: env.OPENCLAW_BASE_URL,
              token: env.OPENCLAW_GATEWAY_TOKEN,
            }),
          }
        : null;
  const historySync = gatewayClients
    ? new HistorySync({
        tools: gatewayClients.tools,
        onAttachment: opts.onAttachment ?? null,
        onError: (err, sessionId) => app.log.error({ err, sessionId }, 'history-sync failed'),
      })
    : null;
  app.decorate('turnRegistry', new TurnRegistry());
  app.decorate('turnLimiter', new TurnConcurrencyLimiter({
    globalLimit: env.MAX_CONCURRENT_TURNS_GLOBAL,
    queueLimit: env.MAX_QUEUED_TURNS_GLOBAL,
    queueTimeoutMs: env.TURN_QUEUE_TIMEOUT_MS,
  }));
  app.decorate('historySync', historySync);
  app.decorate('gatewayCompat', gatewayClients?.compat ?? null);
  app.addHook('onClose', async () => {
    historySync?.stop();
    app.turnLimiter.close();
  });

  // One process-wide media pipeline/watcher shared by chat and Studio.
  //
  // Chat media uses exact history-sync attachment sightings; Studio uses the
  // same watcher for claimNext(). A raw async file with no exact transcript
  // sighting parks safely rather than inheriting a merely recent chat turn.
  const mediaPipeline = new MediaPipeline({ bus: app.eventsBus, logger: app.log });
  const isStudioKindQuarantined = (outputKind: AttachmentKind) =>
    outputKind === 'file'
      ? Promise.resolve(false)
      : isStudioOutputKindQuarantined({ outputKind });
  const mediaWatcher = new MediaWatcher({
    pipeline: mediaPipeline,
    logger: app.log,
    isStudioKindQuarantined,
  });
  if (historySync) {
    historySync.setAttachmentCallback(
      opts.onAttachment ??
        createAttachmentSightingHandler({
          pipeline: mediaPipeline,
          watcher: mediaWatcher,
          logger: app.log,
          isStudioKindQuarantined,
        }),
    );
  }
  app.addHook('onClose', async () => {
    await mediaWatcher.stop();
  });
  if (opts.media?.autoStartWatcher === true) {
    await mediaWatcher.start();
  }

  // Provisioning seam (agent create/persona edit, trigger cron-sync) — lazy
  // real clients by default, fakes injectable via opts.provisioning.
  app.decorate('gatewayGlue', new GatewayGlue(opts.provisioning));

  const agentProvisioningWorker = new AgentProvisioningWorker({
    provisioner: {
      provisionAgent: (params, options) =>
        app.gatewayGlue.provisioner.provisionAgent(params, options),
      updateAgentPersona: (params) => app.gatewayGlue.provisioner.updateAgentPersona(params),
    },
    skillSync: {
      syncAgentSkills: (params) => app.gatewayGlue.skillSync.syncAgentSkills(params),
    },
    toolSync: {
      syncAgentToolGroups: (params) => app.gatewayGlue.toolSync.syncAgentToolGroups(params),
    },
    bus: app.eventsBus,
    logger: app.log,
    ...(opts.agentProvisioning ?? {}),
  });
  app.decorate('agentProvisioningWorker', agentProvisioningWorker);
  app.addHook('onClose', async () => agentProvisioningWorker.stop());

  // DB-authoritative runtime/persona convergence. Route edits attempt an
  // immediate fenced sync; this independent loop closes every process-death,
  // gateway-outage, and partial-filesystem-restore window from the durable
  // pending revision. It is intentionally tied to production auto-start but
  // not to scheduled-task firing or gateway chat-client construction.
  const agentRuntimeSyncScheduler =
    opts.scheduler?.autoStart === true
      ? new AgentRuntimeSyncScheduler({
          // Keep construction lazy so a missing host gateway token preserves
          // the documented read-only/degraded API boot. Individual retries
          // fail durably with backoff until credentials are restored.
          provisioner: {
            provisionAgent: (params, options) =>
              app.gatewayGlue.provisioner.provisionAgent(params, options),
            updateAgentPersona: (params) =>
              app.gatewayGlue.provisioner.updateAgentPersona(params),
          },
          toolSync: app.gatewayGlue.toolSync,
          skillSync: app.gatewayGlue.skillSync,
          logger: app.log,
        })
      : null;
  app.addHook('onClose', async () => agentRuntimeSyncScheduler?.stop());
  agentRuntimeSyncScheduler?.start();

  // Eden3-side scheduled-task firing. Constructed whenever a gateway is
  // wired (scheduled runs are real metered agent turns), but only STARTED
  // when the entrypoint opts in — tests drive tick() themselves. Interval 0
  // (TASK_SCHEDULER_INTERVAL_MS) disables task firing but not the independent
  // native-cron cleanup safety loop or provider-free billing recovery loop.
  const taskScheduler = new TaskScheduler({
    runTask:
      gatewayClients && historySync
        ? makeScheduledTaskRunner({
            compat: gatewayClients.compat,
            bus: app.eventsBus,
            registry: app.turnRegistry,
            historySync,
            turnLimiter: app.turnLimiter,
            onError: (err, context) => app.log.error({ err, context }, 'scheduled task side-error'),
          })
        : async () => {
            throw new ApiError(503, 'gateway_unavailable', 'Scheduled task runtime is unavailable');
          },
    // Compensation never needs the gateway. Keep this runner/timer alive in
    // degraded mode and when normal scheduled firing is explicitly disabled.
    recoverTask: makeScheduledTaskRecoveryRunner({
      onError: (err, context) => app.log.error({ err, context }, 'scheduled task recovery side-error'),
    }),
    // A degraded API still starts the independent native-cron safety sweep,
    // but never attempts provider turns without chat clients.
    intervalMs: gatewayClients && historySync ? env.TASK_SCHEDULER_INTERVAL_MS : 0,
    cleanupGatewayJobs: () => app.gatewayGlue.cronSync.removeAllEden3Jobs(),
    logger: app.log,
  });
  app.decorate('taskScheduler', taskScheduler);
  app.addHook('onClose', async () => {
    taskScheduler?.stop();
  });
  if (opts.scheduler?.autoStart === true) taskScheduler?.start();

  // Compensation for orphaned worst-case turn reservations (gap 42): a
  // process death between the committed reservation and terminal persistence
  // leaves the authorization row 'reserved'; the reaper reverses it after the
  // TTL. Provider-free, gateway-independent — alive even in degraded mode.
  // Follows the scheduler's autoStart discipline (tests drive runOnce()).
  const turnReservationReaper = new TurnReservationReaper({
    onError: (err, context) => app.log.error({ err, context }, 'turn-reservation reaper side-error'),
  });
  app.decorate('turnReservationReaper', turnReservationReaper);
  app.addHook('onClose', async () => {
    turnReservationReaper.stop();
  });
  if (opts.scheduler?.autoStart === true) turnReservationReaper.start();

  // Studio uses usage_events as a durable authorization row. This independent,
  // provider-free loop reverses stale pending/refund_pending reservations even
  // when the gateway is absent or normal scheduled firing is disabled.
  const studioReservationReaper = new StudioReservationReaper({
    onError: (err, context) => app.log.error({ err, context }, 'studio-reservation reaper side-error'),
  });
  app.decorate('studioReservationReaper', studioReservationReaper);
  app.addHook('onClose', async () => {
    studioReservationReaper.stop();
  });
  if (opts.scheduler?.autoStart === true) studioReservationReaper.start();

  const chatMediaReservationReaper = new ChatMediaReservationReaper({
    onError: (err, context) => app.log.error({ err, context }, 'chat-media reaper side-error'),
  });
  app.decorate('chatMediaReservationReaper', chatMediaReservationReaper);
  app.addHook('onClose', async () => {
    chatMediaReservationReaper.stop();
  });
  if (opts.scheduler?.autoStart === true) chatMediaReservationReaper.start();

  const memoryDreamScheduler =
    gatewayClients && historySync
      ? new MemoryDreamScheduler(
          new MemoryDreamOrchestrator(
            new PostgresMemoryDreamStore(),
            new EdenMemoryDreamAgentRunner({
              compat: gatewayClients.compat,
              bus: app.eventsBus,
              registry: app.turnRegistry,
              historySync,
              memoryRuntime: app.gatewayGlue.memoryRuntime,
              modelRuntime: app.gatewayGlue.modelRuntime,
              onError: (err, context) =>
                app.log.error({ err, context }, 'memory dream side-error'),
            }),
          ),
          {
            intervalMs: env.MEMORY_DREAM_SCHEDULER_INTERVAL_MS,
            hourUtc: env.MEMORY_DREAM_HOUR_UTC,
            onError: (err) => app.log.error({ err }, 'memory dream scheduler tick failed'),
          },
        )
      : null;
  app.decorate('memoryDreamScheduler', memoryDreamScheduler);
  app.addHook('onClose', async () => {
    memoryDreamScheduler?.stop();
  });
  if (opts.scheduler?.autoStart === true) memoryDreamScheduler?.start();
  await (opts.bootstrap?.ensureBuiltinSkills ?? ensureBuiltinSkills)();
  if (opts.scheduler?.autoStart === true) agentProvisioningWorker.start();
  await (opts.bootstrap?.ensureEveAssistant ?? ensureEveAssistant)({
    // The real API entrypoint starts the media watcher and talks to the live
    // gateway. In that mode @eve must also sync OpenClaw's default workspace;
    // route tests can still bootstrap the DB row without touching live gateway
    // state.
    syncWorkspace: opts.media?.autoStartWatcher === true && gatewayClients !== null,
    dataDir: defaultOpenclawDataDir(),
  });

  // Resource routes (remaining stub: studio) + real dev/chat/session routes.
  await app.register(chatRoutes, {
    prefix: '/sessions',
    ...(opts.accountErasure
      ? { providerEvidenceDb: opts.accountErasure.providerEvidenceDb }
      : {}),
  }); // POST /sessions/:idOrNew/messages
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(notificationsRoutes, {
    prefix: '/notifications',
    ...(opts.notifications ?? {}),
  });
  await app.register(accountRoutes, {
    prefix: '/account',
    erasure: opts.accountErasure,
  });
  if (opts.accountErasure?.autoStart === true) {
    registerAccountErasureBackgroundLifecycle(app, {
      autoStart: true,
      recoveryWorker: opts.accountErasure.recoveryWorker,
      targetWorker: opts.accountErasure.targetWorker,
      intervalMs: opts.accountErasure.intervalMs ?? accountErasureIntervalMs(),
      logger: app.log,
    });
  }
  await app.register(sessionsRoutes, { prefix: '/sessions' });
  await app.register(agentsRoutes, { prefix: '/agents' });
  // Concepts share the /agents path root (/agents/:username/concepts/*).
  await app.register(conceptsRoutes, { prefix: '/agents' });
  // Owner-only workspace file browser (tree/read/download/export/save).
  await app.register(workspaceRoutes, { prefix: '/agents' });
  await app.register(skillsRoutes);
  await app.register(creationsRoutes, { prefix: '/creations' });
  await app.register(feedRoutes, { prefix: '/feed' });
  // No prefix: collections spans /collections/* AND /users/:username/collections.
  await app.register(collectionsRoutes);
  await app.register(billingRoutes, { prefix: '/billing', ...(opts.billing ?? {}) });
  await app.register(channelsRoutes, {
    prefix: '/channels',
    ...(opts.channels ?? {}),
    ...(opts.accountErasure
      ? { providerEvidenceDb: opts.accountErasure.providerEvidenceDb }
      : {}),
  });
  // Gateway-only fail-closed media authorization callbacks. These exact POST
  // routes authenticate the gateway bearer before any allowlist bypass.
  await app.register(mediaRuntimeRoutes, {
    prefix: '/media',
    ...(opts.accountErasure
      ? { providerEvidenceDb: opts.accountErasure.providerEvidenceDb }
      : {}),
  });
  await app.register(mannaRoutes, { prefix: '/manna' });
  // /usage — the tenant view of consumption (own balance/spend/activity).
  // Distinct from /operator (admin platform view); never exposes cost_usd.
  await app.register(usageRoutes, { prefix: '/usage' });
  await app.register(operatorRoutes, { prefix: '/operator' });
  await app.register(searchRoutes, { prefix: '/search' });
  await app.register(sessionShareRoutes, {
    repository: opts.shares?.repository ?? new PostgresSessionShareRepository(),
  });
  const storageRuntime =
    opts.storage?.runtime ??
    (opts.storage?.enabled === true
      ? await createStorageRuntime({ mediaDir: env.MEDIA_DIR, logger: app.log })
      : null);
  if (storageRuntime) {
    // Register the lifecycle-aware UUID route before the legacy static
    // wildcard. The backend and hydration cache are separately rooted and
    // can never be reached through the public MEDIA_DIR mount.
    await app.register(mediaObjectRoutes, { resolver: storageRuntime.mediaResolver });
    await app.register(uploadsRoutes, { service: storageRuntime.uploadService });
    if (opts.storage?.autoStartPolicyWorker === true) {
      const hasPolicyActivity = (result: PolicyEventTickResult): boolean =>
        result.recovered > 0 ||
        result.recoveryFailed > 0 ||
        result.claimed > 0 ||
        result.delivered > 0 ||
        result.retried > 0 ||
        result.terminalFailed > 0 ||
        result.stale > 0 ||
        result.metrics.pending > 0 ||
        result.metrics.claimed > 0 ||
        result.metrics.failed > 0 ||
        result.metrics.oldestPendingAgeMs > 0 ||
        result.metrics.maxAttemptCount > 0;
      const policyLoop = await startBackgroundWorkerLoop({
        intervalMs: storagePolicyIntervalMs(),
        tick: () => storageRuntime.policyEventWorker.tick(),
        onResult: (result) => {
          if (!hasPolicyActivity(result)) return;
          const context = { policyEvents: result };
          if (
            result.recoveryFailed > 0 ||
            result.retried > 0 ||
            result.terminalFailed > 0 ||
            result.stale > 0 ||
            result.metrics.failed > 0
          ) {
            app.log.warn(context, 'upload policy event tick requires attention');
          } else {
            app.log.info(context, 'upload policy event tick');
          }
        },
        onError: (err) => app.log.error({ err }, 'upload policy event tick failed'),
      });
      app.addHook('onClose', async () => policyLoop.stop());

      const hasCleanupActivity = (result: MultipartCleanupTickResult): boolean =>
        result.expiredEnqueued > 0 ||
        result.recovered > 0 ||
        result.recoveryFailed > 0 ||
        result.claimed > 0 ||
        result.succeeded > 0 ||
        result.retried > 0 ||
        result.terminalFailed > 0 ||
        result.stale > 0 ||
        result.metrics.pending > 0 ||
        result.metrics.claimed > 0 ||
        result.metrics.failed > 0 ||
        result.metrics.oldestPendingAgeMs > 0 ||
        result.metrics.maxAttemptCount > 0;
      const cleanupLoop = await startBackgroundWorkerLoop({
        intervalMs: storageCleanupIntervalMs(),
        tick: () => storageRuntime.multipartCleanupWorker.tick(),
        onResult: (result) => {
          if (!hasCleanupActivity(result)) return;
          const context = { multipartCleanup: result };
          if (
            result.recoveryFailed > 0 ||
            result.retried > 0 ||
            result.terminalFailed > 0 ||
            result.stale > 0 ||
            result.metrics.failed > 0
          ) {
            app.log.warn(context, 'multipart cleanup tick requires attention');
          } else {
            app.log.info(context, 'multipart cleanup tick');
          }
        },
        onError: (err) => app.log.error({ err }, 'multipart cleanup tick failed'),
      });
      app.addHook('onClose', async () => cleanupLoop.stop());
    }
  }
  // Existing generated media keeps its content-addressed filename URLs. This
  // wildcard is deliberately registered after `/media/:objectId`; it serves
  // only MEDIA_DIR and cannot see pending/quarantined object-backend bytes.
  mkdirSync(env.MEDIA_DIR, { recursive: true });
  await app.register(async (legacyMedia) => {
    legacyMedia.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?', 1)[0]!;
      try {
        if (await legacyMediaIsPubliclyReachable(pg, path)) return;
      } catch (err) {
        logSafeRequestError(req.log, err, {}, 'legacy media visibility check failed');
      }
      return reply.code(404).send(errorEnvelope(404, 'not_found', 'Media not found'));
    });
    await legacyMedia.register(fastifyStatic, {
      root: env.MEDIA_DIR,
      prefix: '/media/',
      index: false,
      list: false,
    });
  });
  // Trigger routes live at /tasks on the wire (web contract).
  await app.register(triggersRoutes, { prefix: '/tasks' });
  await app.register(studioRoutes, {
    prefix: '/studio',
    deps: { pipeline: mediaPipeline, watcher: mediaWatcher },
  });
  // Impersonation routes mount only for dev auth or an explicit env opt-in —
  // a deployed API (clerk/hybrid without EDEN3_DEV_ROUTES) 404s the whole
  // /dev prefix (see routes/dev.ts).
  if (env.AUTH_PROVIDER === 'dev' || env.EDEN3_DEV_ROUTES) {
    await app.register(devRoutes, { prefix: '/dev' });
  }

  return app;
}
