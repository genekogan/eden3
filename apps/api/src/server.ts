import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

import { getEnv } from '@eden3/core';
import { OpenClawCompatClient, OpenClawToolsClient } from '@eden3/gateway';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { ZodError } from 'zod';

import { registerAuth, type AuthPluginOptions } from './auth-plugin';
import { ApiError, errorEnvelope } from './errors';
import { EventsBus, sessionEventsRoutes } from './events-bus';
import { GatewayGlue, defaultOpenclawDataDir, type GatewayGlueOptions } from './gateway-glue';
import { TurnConcurrencyLimiter } from './services/chat-limits';
import { ensureBuiltinSkills } from './services/agent-skills';
import { ensureEveAssistant } from './services/default-assistant';
import { registerHttpHardening } from './services/http-hardening';
import { HistorySync, type AttachmentCallback, type ToolsClientLike } from './services/history-sync';
import { AgentRuntimeSyncScheduler } from './services/agent-runtime-sync';
import { MediaPipeline } from './services/media-pipeline';
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
import { operatorRoutes } from './routes/operator';
import { sessionsRoutes } from './routes/sessions';
import { skillsRoutes } from './routes/skills';
import { studioRoutes } from './routes/studio';
import { triggersRoutes } from './routes/triggers';
import { usageRoutes } from './routes/usage';
import { workspaceRoutes } from './routes/workspace';

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
  scheduler?: {
    /**
     * Start the scheduled-task loop during server boot. Entrypoints should
     * enable this; tests leave it off and drive `app.taskScheduler.tick()`
     * (or their own TaskScheduler) directly.
     */
    autoStart?: boolean;
  };
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
    /** Eden-managed, activity-gated native deep + metered REM loop. */
    memoryDreamScheduler: MemoryDreamScheduler | null;
  }
}

/**
 * Build the eden3 API server (not yet listening — callers `listen()` or
 * `inject()`). Env is read via @eden3/core `getEnv()`; entrypoints must have
 * populated process.env first (loadRootEnv).
 */
export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const env = getEnv();

  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: env.API_BODY_LIMIT_BYTES,
    disableRequestLogging: true, // replaced by structured redacted logging below
    forceCloseConnections: true, // don't let open SSE sockets block close()
  });

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
          url: req.url,
          statusCode: reply.statusCode,
          elapsedMs: Number(reply.elapsedTime.toFixed(1)),
          ...(sessionId ? { sessionId } : {}),
        },
        'request completed',
      );
    });
  }

  // Global error envelope.
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
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
    } else if (
      err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ||
      (typeof err.statusCode === 'number' && err.statusCode === 413)
    ) {
      statusCode = 413;
      code = 'payload_too_large';
      message = `Request body exceeds ${env.API_BODY_LIMIT_BYTES} bytes`;
    } else {
      statusCode =
        typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
      code = statusCode >= 500 ? 'internal_error' : (err.code ?? 'bad_request');
      message = err.message || 'Internal server error';
    }
    if (statusCode >= 500) req.log.error({ err }, 'request failed');
    void reply.code(statusCode).send(errorEnvelope(statusCode, code, message));
  });

  app.setNotFoundHandler((req, reply) => {
    void reply
      .code(404)
      .send(errorEnvelope(404, 'not_found', `Route ${req.method} ${req.url} not found`));
  });

  registerHttpHardening(app, {
    rateLimit: { windowMs: env.API_RATE_LIMIT_WINDOW_MS, max: env.API_RATE_LIMIT_MAX },
  });

  await app.register(fastifyCors, {
    origin: [`http://localhost:${env.WEB_PORT}`, `http://127.0.0.1:${env.WEB_PORT}`],
    credentials: true,
    exposedHeaders: ['x-session-id'], // new-session hint on POST …/messages
  });

  // Media files (content-addressed) served from MEDIA_DIR at /media/.
  mkdirSync(env.MEDIA_DIR, { recursive: true });
  await app.register(fastifyStatic, {
    root: env.MEDIA_DIR,
    prefix: '/media/',
    index: false,
    list: false,
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

  app.get('/health', async () => ({
    ok: true,
    versions: { api: pkg.version, node: process.version, fastify: app.version },
    database: databaseName,
  }));

  // Auth (request.account + app.requireAuth) — root scope, before routes.
  registerAuth(app, opts.auth);

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
  app.decorate('turnLimiter', new TurnConcurrencyLimiter());
  app.decorate('historySync', historySync);
  app.decorate('gatewayCompat', gatewayClients?.compat ?? null);
  app.addHook('onClose', async () => {
    historySync?.stop();
  });

  // One process-wide media pipeline/watcher shared by chat and Studio.
  //
  // Chat media needs the watcher wired to `turnRegistry` and history-sync
  // attachment sightings; Studio needs the same watcher for claimNext(). A
  // route-local Studio watcher would see files, but would not know which chat
  // session was recently active, so async in-chat images would park.
  const mediaPipeline = new MediaPipeline({ bus: app.eventsBus, logger: app.log });
  const mediaWatcher = new MediaWatcher({
    pipeline: mediaPipeline,
    logger: app.log,
    turnRegistry: app.turnRegistry,
  });
  if (historySync) {
    historySync.setAttachmentCallback(
      opts.onAttachment ??
        createAttachmentSightingHandler({
          pipeline: mediaPipeline,
          watcher: mediaWatcher,
          logger: app.log,
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
  await ensureBuiltinSkills();
  await ensureEveAssistant({
    // The real API entrypoint starts the media watcher and talks to the live
    // gateway. In that mode @eve must also sync OpenClaw's default workspace;
    // route tests can still bootstrap the DB row without touching live gateway
    // state.
    syncWorkspace: opts.media?.autoStartWatcher === true && gatewayClients !== null,
    dataDir: defaultOpenclawDataDir(),
  });

  // Resource routes (remaining stub: studio) + real dev/chat/session routes.
  await app.register(chatRoutes, { prefix: '/sessions' }); // POST /sessions/:idOrNew/messages
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(accountRoutes, { prefix: '/account' });
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
  await app.register(channelsRoutes, { prefix: '/channels', ...(opts.channels ?? {}) });
  await app.register(mannaRoutes, { prefix: '/manna' });
  // /usage — the tenant view of consumption (own balance/spend/activity).
  // Distinct from /operator (admin platform view); never exposes cost_usd.
  await app.register(usageRoutes, { prefix: '/usage' });
  await app.register(operatorRoutes, { prefix: '/operator' });
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
