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
import { GatewayGlue, type GatewayGlueOptions } from './gateway-glue';
import { HistorySync, type AttachmentCallback, type ToolsClientLike } from './services/history-sync';
import { TurnRegistry } from './services/turn-registry';
import type { CompatClientLike } from './services/turns';
import { agentsRoutes } from './routes/agents';
import { chatRoutes } from './routes/chat';
import { collectionsRoutes } from './routes/collections';
import { creationsRoutes } from './routes/creations';
import { devRoutes } from './routes/dev';
import { feedRoutes } from './routes/feed';
import { mannaRoutes } from './routes/manna';
import { sessionsRoutes } from './routes/sessions';
import { studioRoutes } from './routes/studio';
import { triggersRoutes } from './routes/triggers';

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
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Media-correlation registry of recently-active chat turns. */
    turnRegistry: TurnRegistry;
    /** Gateway transcript sync (null when the gateway is not configured). */
    historySync: HistorySync | null;
    /** Streaming chat client (null when the gateway is not configured). */
    gatewayCompat: CompatClientLike | null;
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
    disableRequestLogging: true, // replaced by the compact one-liner below
    forceCloseConnections: true, // don't let open SSE sockets block close()
  });

  // Compact request logging: one line per response.
  if (opts.logger) {
    app.addHook('onResponse', async (req, reply) => {
      req.log.info(
        `${req.method} ${req.url} -> ${reply.statusCode} ${reply.elapsedTime.toFixed(1)}ms`,
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

  app.get('/health', async () => ({
    ok: true,
    versions: { api: pkg.version, node: process.version, fastify: app.version },
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
  app.decorate('historySync', historySync);
  app.decorate('gatewayCompat', gatewayClients?.compat ?? null);
  app.addHook('onClose', async () => {
    historySync?.stop();
  });

  // Provisioning seam (agent create/persona edit, trigger cron-sync) — lazy
  // real clients by default, fakes injectable via opts.provisioning.
  app.decorate('gatewayGlue', new GatewayGlue(opts.provisioning));

  // Resource routes (remaining stub: studio) + real dev/chat/session routes.
  await app.register(chatRoutes, { prefix: '/sessions' }); // POST /sessions/:idOrNew/messages
  await app.register(sessionsRoutes, { prefix: '/sessions' });
  await app.register(agentsRoutes, { prefix: '/agents' });
  await app.register(creationsRoutes, { prefix: '/creations' });
  await app.register(feedRoutes, { prefix: '/feed' });
  // No prefix: collections spans /collections/* AND /users/:username/collections.
  await app.register(collectionsRoutes);
  await app.register(mannaRoutes, { prefix: '/manna' });
  // Trigger routes live at /tasks on the wire (web contract).
  await app.register(triggersRoutes, { prefix: '/tasks' });
  await app.register(studioRoutes, { prefix: '/studio' });
  await app.register(devRoutes, { prefix: '/dev' });

  return app;
}
