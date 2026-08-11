import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  errorEnvelope,
  logSafeRequestError,
  logSafeRequestWarning,
  safeRequestErrorCallback,
  safeServerErrorLog,
  sendError,
} from '../src/errors';
import { buildServer, registerApiErrorHandler } from '../src/server';
import { recordStudioReversal } from '../src/routes/studio';
import { publishMediaEventsSafely } from '../src/services/media-pipeline';

const SENSITIVE = 'SENSITIVE_5XX_SENTINEL_do_not_expose';
const SECRET_CODE = 'secret_token_value';
const SECRET_ERRNO = 'ESECRET_TOKEN_VALUE';
const SECRET_ERROR_NAME = 'SecretTokenError';

const REVIEWED_BACKGROUND_THROWABLE_LOG_ANCHORS: string[] = [
  "routes/channels.ts|variable:reap>variable:channelsRoutes|app.log|channel turn stale-refund sweep failed|app.log.error({ err: error }, 'channel turn stale-refund sweep failed')",
  "server.ts|property:onError>function:buildServer|app.log|chat-media reaper side-error|app.log.error({ err, context }, 'chat-media reaper side-error')",
  "server.ts|property:onError>function:buildServer|app.log|history-sync failed|app.log.error({ err, sessionId }, 'history-sync failed')",
  "server.ts|property:onError>function:buildServer|app.log|memory dream scheduler tick failed|app.log.error({ err }, 'memory dream scheduler tick failed')",
  "server.ts|property:onError>function:buildServer|app.log|memory dream side-error|app.log.error({ err, context }, 'memory dream side-error')",
  "server.ts|property:onError>function:buildServer|app.log|multipart cleanup tick failed|app.log.error({ err }, 'multipart cleanup tick failed')",
  "server.ts|property:onError>function:buildServer|app.log|scheduled task recovery side-error|app.log.error({ err, context }, 'scheduled task recovery side-error')",
  "server.ts|property:onError>function:buildServer|app.log|scheduled task side-error|app.log.error({ err, context }, 'scheduled task side-error')",
  "server.ts|property:onError>function:buildServer|app.log|studio-reservation reaper side-error|app.log.error({ err, context }, 'studio-reservation reaper side-error')",
  "server.ts|property:onError>function:buildServer|app.log|turn-reservation reaper side-error|app.log.error({ err, context }, 'turn-reservation reaper side-error')",
  "server.ts|property:onError>function:buildServer|app.log|upload policy event tick failed|app.log.error({ err }, 'upload policy event tick failed')",
  "services/account-erasure-runtime.ts|property:onError>function:startAccountErasureBackgroundLoop|options.logger|account erasure tick failed|options.logger.error({ err: error }, 'account erasure tick failed')",
  "services/agent-provisioning.ts|callback:catch>callback:setInterval>method:process|this.options.logger|agent provisioning heartbeat failed|this.options.logger?.warn( { err: error, agentAccountId: claim.agentAccountId }, 'agent provisioning heartbeat failed', )",
  "services/agent-provisioning.ts|callback:catch>method:kick|this.options.logger|agent provisioning tick failed|this.options.logger?.error({ err: error }, 'agent provisioning tick failed')",
  "services/agent-provisioning.ts|method:process|this.options.logger|agent provisioning attempt failed|this.options.logger?.error( { err: error, agentAccountId: claim.agentAccountId }, 'agent provisioning attempt failed', )",
  "services/agent-runtime-sync.ts|method:tick|this.deps.logger|agent runtime sync tick failed|this.deps.logger?.error({ err: error }, 'agent runtime sync tick failed')",
  "services/storage-runtime.ts|property:onError>function:createStorageRuntime|options.logger|(dynamic)|options.logger.error( { err: error, ...context }, context.terminal ? 'multipart upload cleanup exhausted retries' : 'multipart upload cleanup attempt failed', )",
  "services/task-scheduler.ts|callback:catch>callback:setInterval>method:start|this.log|task-scheduler: recovery tick failed|this.log?.error({ err }, 'task-scheduler: recovery tick failed')",
  "services/task-scheduler.ts|callback:catch>callback:setInterval>method:start|this.log|task-scheduler: tick failed|this.log?.error({ err }, 'task-scheduler: tick failed')",
  "services/task-scheduler.ts|callback:catch>method:ensureGatewayJobsCleaned|this.log|task-scheduler: legacy gateway cron cleanup failed|this.log?.warn({ err }, 'task-scheduler: legacy gateway cron cleanup failed')",
  "services/task-scheduler.ts|method:processDue|this.log|task-scheduler: scheduled run failed|this.log?.error({ err, triggerId: row.id }, 'task-scheduler: scheduled run failed')",
  'workers/media-watcher.ts|callback:catch>variable:handler>function:createAttachmentSightingHandler|log|(dynamic)|log.error(`media-sighting: failed for ${sighting.path}: ${String(err)}`)',
  'workers/media-watcher.ts|callback:watcher.on:error>callback:(anonymous)>method:start|this.log|(dynamic)|this.log.error(`media-watcher: watch error: ${String(err)}`)',
  'workers/media-watcher.ts|method:handleStableFile|this.log|(dynamic)|this.log.warn(`media-watcher: Studio quarantine check failed closed: ${String(err)}`)',
  'workers/media-watcher.ts|method:handleStableFile|this.log|(dynamic)|this.log.warn(`media-watcher: history-sync failed for ${filePath}: ${String(err)}`)',
  'workers/media-watcher.ts|method:ingest|this.log|(dynamic)|this.log.error(`media-watcher: ingest failed for ${file.path}: ${String(err)}`)',
  'workers/media-watcher.ts|method:tick|this.log|(dynamic)|this.log.error(`media-watcher: failed to handle ${filePath}: ${String(err)}`)',
  'workers/media-watcher.ts|variable:run>function:createAttachmentSightingHandler|log|(dynamic)|log.warn(`media-sighting: Studio quarantine check failed closed: ${String(err)}`)',
];

async function typescriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return typescriptFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  }));
  return nested.flat();
}

function rawThrowableLoggerFindings(filePath: string, sourceText: string): string[] {
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const loggerAliases = new Set(['log', 'logger']);
  const throwableNames = new Set(['cause', 'err', 'error', 'failure']);
  const compact = (value: string) => value.replace(/\s+/g, ' ').trim();
  const callLabel = (expression: ts.Expression): string => {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) {
      return ts.isIdentifier(expression.expression)
        ? `${expression.expression.text}.${expression.name.text}`
        : expression.name.text;
    }
    return expression.kind === ts.SyntaxKind.TaggedTemplateExpression ? 'tagged-template' : 'call';
  };
  const functionOwnership = (node: ts.Node): string => {
    const owners: string[] = [];
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isFunctionDeclaration(current) && current.name) {
        owners.push(`function:${current.name.text}`);
      } else if (ts.isMethodDeclaration(current) && current.name) {
        owners.push(`method:${compact(current.name.getText(source))}`);
      } else if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        const parent = current.parent;
        if (ts.isPropertyAssignment(parent)) {
          owners.push(`property:${compact(parent.name.getText(source))}`);
        } else if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
          owners.push(`variable:${parent.name.text}`);
        } else if (ts.isCallExpression(parent)) {
          const firstArg = parent.arguments[0];
          const discriminator = firstArg && ts.isStringLiteral(firstArg) ? `:${firstArg.text}` : '';
          owners.push(`callback:${callLabel(parent.expression)}${discriminator}`);
        } else {
          owners.push('callback:(anonymous)');
        }
      }
    }
    return owners.join('>') || '(top-level)';
  };
  const loggerLike = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) return loggerAliases.has(node.text);
    if (ts.isPropertyAccessExpression(node)) {
      return node.name.text === 'log' || node.name.text === 'logger';
    }
    return false;
  };
  const collectAliases = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const initializer = node.initializer;
      const childSource = ts.isCallExpression(initializer) &&
        ts.isPropertyAccessExpression(initializer.expression) &&
        initializer.expression.name.text === 'child'
        ? initializer.expression.expression
        : initializer;
      if (loggerLike(childSource)) loggerAliases.add(node.name.text);
    }
    if (ts.isCatchClause(node) && node.variableDeclaration &&
        ts.isIdentifier(node.variableDeclaration.name)) {
      throwableNames.add(node.variableDeclaration.name.text);
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) &&
        /^(?:cause|err|error|failure)$/i.test(node.name.text)) {
      throwableNames.add(node.name.text);
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(source);
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const logger = node.expression.expression;
      if (
        (method === 'error' || method === 'warn') &&
        loggerLike(logger)
      ) {
        const messageArg = node.arguments.at(-1);
        const message = messageArg && ts.isStringLiteral(messageArg) ? messageArg.text : '(dynamic)';
        let unsafe = false;
        for (const argument of node.arguments) {
          const inspect = (candidate: ts.Node): void => {
            if (ts.isIdentifier(candidate) && throwableNames.has(candidate.text)) {
              unsafe = true;
            }
            if (ts.isNewExpression(candidate) &&
                ts.isIdentifier(candidate.expression) && candidate.expression.text === 'Error') {
              unsafe = true;
            }
            ts.forEachChild(candidate, inspect);
          };
          inspect(argument);
        }
        if (unsafe) {
          findings.push([
            filePath,
            functionOwnership(node),
            compact(logger.getText(source)),
            message,
            compact(node.getText(source)),
          ].join('|'));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

describe('HTTP 5xx disclosure boundary', () => {
  const apps: FastifyInstance[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
    vi.unstubAllEnvs();
  });

  it.each([
    [500, 'Internal server error'],
    [501, 'Service temporarily unavailable'],
    [502, 'Upstream service unavailable'],
    [503, 'Service temporarily unavailable'],
    [504, 'Request timed out'],
    [599, 'Service temporarily unavailable'],
  ] as const)('replaces untrusted %i text with one reviewed public message', (status, expected) => {
    const envelope = errorEnvelope(status, 'agent_provision_failed', SENSITIVE);

    expect(envelope).toEqual({
      error: { code: 'agent_provision_failed', message: expected, statusCode: status },
    });
    expect(JSON.stringify(envelope)).not.toContain(SENSITIVE);
  });

  it('preserves actionable 4xx text and exact status/code', () => {
    expect(errorEnvelope(409, 'write_conflict', 'Reload before saving')).toEqual({
      error: {
        code: 'write_conflict',
        message: 'Reload before saving',
        statusCode: 409,
      },
    });
  });

  it('rejects a grammar-valid injected 5xx machine code while preserving the status', () => {
    const envelope = errorEnvelope(503, SECRET_CODE, SENSITIVE);

    expect(envelope).toEqual({
      error: {
        code: 'internal_error',
        message: 'Service temporarily unavailable',
        statusCode: 503,
      },
    });
    expect(JSON.stringify(envelope)).not.toContain(SENSITIVE);
    expect(JSON.stringify(envelope)).not.toContain(SECRET_CODE);
  });

  it.each(['turn_capacity_exceeded', 'turn_queue_timeout'] as const)(
    'preserves reviewed overload code %s while redacting internal text',
    (code) => {
      const envelope = errorEnvelope(503, code, SENSITIVE);

      expect(envelope).toEqual({
        error: {
          code,
          message: 'Service temporarily unavailable',
          statusCode: 503,
        },
      });
      expect(JSON.stringify(envelope)).not.toContain(SENSITIVE);
    },
  );

  it.each([
    [502, 'provider_error', 'Upstream service unavailable'],
    [502, 'repair_failed', 'Upstream service unavailable'],
  ] as const)(
    'makes direct %s %s sendError calls obey the same 5xx boundary',
    async (status, code, message) => {
      const app = Fastify({ logger: false });
      apps.push(app);
      app.get('/direct', async (_request, reply) =>
        sendError(reply, status, code, SENSITIVE));

      const response = await app.inject({ method: 'GET', url: '/direct' });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({
        error: {
          code,
          message,
          statusCode: status,
        },
      });
      expect(response.body).not.toContain(SENSITIVE);
    },
  );

  it('redacts a grammar-valid injected ApiError code from both response and logs', async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        level: 'error',
        base: undefined,
        stream: { write: (line: string) => lines.push(line) },
      },
    });
    apps.push(app);
    registerApiErrorHandler(app, { bodyLimitBytes: 1_024 });
    app.get('/failure', async () => {
      throw new ApiError(503, SECRET_CODE, SENSITIVE);
    });

    const response = await app.inject({ method: 'GET', url: '/failure' });

    expect(response.json()).toEqual({
      error: {
        code: 'internal_error',
        message: 'Service temporarily unavailable',
        statusCode: 503,
      },
    });
    expect(response.body).not.toContain(SENSITIVE);
    expect(lines.join('\n')).not.toContain(SENSITIVE);
    expect(lines.join('\n')).not.toContain(SECRET_CODE);
  });

  it('enforces redaction through the actual DB-free buildServer composition', async () => {
    const mediaDir = await mkdtemp(path.join(tmpdir(), 'eden3-5xx-redaction-'));
    tempDirs.push(mediaDir);
    vi.stubEnv('MEDIA_DIR', mediaDir);
    vi.stubEnv('CHANNEL_TOKEN_ENCRYPTION_KEY', '11'.repeat(32));
    vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', '');
    const lines: string[] = [];
    const app = await buildServer({
      logger: {
        level: 'error',
        base: undefined,
        stream: { write: (line: string) => lines.push(line) },
      },
      gateway: null,
      bootstrap: {
        ensureBuiltinSkills: async () => {},
        ensureEveAssistant: async () => ({
          accountId: '00000000-0000-4000-8000-000000000001',
          username: 'eve',
          openclawId: 'main',
        }),
      },
    });
    apps.push(app);
    app.get('/__test_only_5xx_composition', async () => {
      throw new ApiError(503, SECRET_CODE, SENSITIVE);
    });
    app.get('/__test_only_raw_5xx_composition', async (_request, reply) =>
      reply.code(502).send({
        error: { code: SECRET_CODE, message: SENSITIVE, statusCode: 502 },
        providerDetail: SENSITIVE,
      }));

    const [response, rawResponse] = await Promise.all([
      app.inject({ method: 'GET', url: '/__test_only_5xx_composition' }),
      app.inject({ method: 'GET', url: '/__test_only_raw_5xx_composition' }),
    ]);

    expect(response.json()).toEqual({
      error: {
        code: 'internal_error',
        message: 'Service temporarily unavailable',
        statusCode: 503,
      },
    });
    expect(response.body).not.toContain(SENSITIVE);
    expect(rawResponse.json()).toEqual({
      error: {
        code: 'internal_error',
        message: 'Upstream service unavailable',
        statusCode: 502,
      },
    });
    expect(rawResponse.body).not.toContain(SENSITIVE);
    expect(rawResponse.body).not.toContain(SECRET_CODE);
    expect(lines.join('\n')).not.toContain(SENSITIVE);
    expect(lines.join('\n')).not.toContain(SECRET_CODE);
  });

  it.each([
    ['ordinary Error', () => new Error(SENSITIVE), 500, 'internal_error', 'Internal server error'],
    [
      'provisioning ApiError',
      () => new ApiError(503, 'agent_provision_failed', SENSITIVE),
      503,
      'agent_provision_failed',
      'Service temporarily unavailable',
    ],
    [
      'skill-sync ApiError',
      () => new ApiError(503, 'skill_sync_failed', SENSITIVE),
      503,
      'skill_sync_failed',
      'Service temporarily unavailable',
    ],
  ] as const)(
    'redacts %s from the production handler response and captured logs',
    async (_name, makeError, status, code, message) => {
      const lines: string[] = [];
      const app = Fastify({
        logger: {
          level: 'error',
          base: undefined,
          stream: { write: (line: string) => lines.push(line) },
        },
      });
      apps.push(app);
      registerApiErrorHandler(app, { bodyLimitBytes: 1_024 });
      app.get('/failure', async () => {
        throw makeError();
      });

      const response = await app.inject({ method: 'GET', url: '/failure' });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error: { code, message, statusCode: status } });
      expect(response.body).not.toContain(SENSITIVE);
      expect(lines.join('\n')).not.toContain(SENSITIVE);
      expect(lines.join('\n')).toContain('request failed');
    },
  );

  it.each([SECRET_ERRNO, 8_675_309])(
    'retains only reviewed exception telemetry without retaining unsafe code %s',
    (unsafeCode) => {
      const error = Object.assign(new Error(SENSITIVE), { code: unsafeCode });

      const context = safeServerErrorLog(error);

      expect(context).toEqual({ errorName: 'Error' });
      expect(JSON.stringify(context)).not.toContain(SENSITIVE);
      expect(JSON.stringify(context)).not.toContain(String(unsafeCode));
    },
  );

  it('rejects injected exception names and codes from safe log metadata', () => {
    const error = Object.assign(new Error('ordinary'), {
      name: SECRET_ERROR_NAME,
      code: SECRET_ERRNO,
    });

    const context = safeServerErrorLog(error);

    expect(context).toEqual({ errorName: 'Error' });
    expect(JSON.stringify(context)).not.toContain(SECRET_ERROR_NAME);
    expect(JSON.stringify(context)).not.toContain(SECRET_ERRNO);
  });

  it('captures request error logs without serializing the throwable', () => {
    const calls: unknown[][] = [];
    const logger = {
      error: (...args: unknown[]) => calls.push(['error', ...args]),
      warn: (...args: unknown[]) => calls.push(['warn', ...args]),
    };
    const error = Object.assign(new Error(SENSITIVE), {
      code: SECRET_ERRNO,
      cause: new Error(SENSITIVE),
    });

    logSafeRequestError(logger, error, { accountId: 'safe-account-id' }, 'request failed');

    expect(calls).toEqual([[
      'error',
      { accountId: 'safe-account-id', errorName: 'Error' },
      'request failed',
    ]]);
    expect(JSON.stringify(calls)).not.toContain(SENSITIVE);
    expect(JSON.stringify(calls)).not.toContain(SECRET_ERRNO);
  });

  it('redacts synchronous, stream-event, and deferred request log callbacks', async () => {
    const calls: unknown[][] = [];
    const logger = {
      error: (...args: unknown[]) => calls.push(['error', ...args]),
      warn: (...args: unknown[]) => calls.push(['warn', ...args]),
    };
    const unsafe = Object.assign(new Error(SENSITIVE), { code: SECRET_ERRNO });

    logSafeRequestWarning(logger, unsafe, { phase: 'sync' }, 'sync failure');
    const stream = new EventEmitter();
    stream.on('error', safeRequestErrorCallback(
      logger,
      { phase: 'stream' },
      'stream failure',
    ));
    stream.emit('error', unsafe);
    await Promise.reject(unsafe).catch(safeRequestErrorCallback(
      logger,
      { phase: 'deferred' },
      'deferred failure',
      'warn',
    ));

    expect(calls).toEqual([
      ['warn', { phase: 'sync', errorName: 'Error' }, 'sync failure'],
      ['error', { phase: 'stream', errorName: 'Error' }, 'stream failure'],
      ['warn', { phase: 'deferred', errorName: 'Error' }, 'deferred failure'],
    ]);
    expect(JSON.stringify(calls)).not.toContain(SENSITIVE);
    expect(JSON.stringify(calls)).not.toContain(SECRET_ERRNO);
  });

  it('redacts an EventBus throwable at the MediaPipeline publish seam', () => {
    const lines: string[] = [];
    const logger = {
      info: (message: string) => lines.push(message),
      warn: (message: string) => lines.push(message),
      error: (message: string) => lines.push(message),
    };
    const bus = {
      publish(): never {
        throw Object.assign(new Error(SENSITIVE), { code: SECRET_ERRNO });
      },
    };

    publishMediaEventsSafely(logger, 'a'.repeat(64), 'ingest', () => {
      bus.publish();
    });

    expect(lines).toEqual([
      `media-pipeline: ingest event publish failed for sha256 ${'a'.repeat(64)}`,
    ]);
    expect(lines.join('\n')).not.toContain(SENSITIVE);
    expect(lines.join('\n')).not.toContain(SECRET_ERRNO);
  });

  it('recursively anchors every raw throwable log to a reviewed background call', async () => {
    const apiSrc = path.resolve(import.meta.dirname, '../src');
    const files = await typescriptFiles(apiSrc);
    const raw: string[] = [];
    for (const file of files) {
      const relative = path.relative(apiSrc, file);
      raw.push(...rawThrowableLoggerFindings(relative, await readFile(file, 'utf8')));
    }

    expect(raw.sort()).toEqual([...REVIEWED_BACKGROUND_THROWABLE_LOG_ANCHORS].sort());
  });

  it.each([
    [
      'logger alias',
      `async function run(log) { try { await work(); } catch (failure) {
        log.error({ err: failure }, 'aliased failure');
      } }`,
    ],
    [
      'service receiving a request logger',
      `async function reconcile(deps) { try { await work(); } catch (cause) {
        deps.logger.warn({ err: cause }, 'service failure');
      } }`,
    ],
    [
      'renamed throwable',
      `try { work(); } catch (failure) { app.log.error({ failure }, 'renamed failure'); }`,
    ],
    [
      'child logger',
      `const child = req.log.child({ route: 'x' });
       try { work(); } catch (cause) { child.warn({ cause }, 'child failure'); }`,
    ],
    [
      'request-owned background-message laundering',
      `try { work(); } catch (err) { req.log.error({ err }, 'history-sync failed'); }`,
    ],
  ])('detects raw throwable logging through a %s mutant', (_name, source) => {
    expect(rawThrowableLoggerFindings('mutant.ts', source)).toHaveLength(1);
  });

  it('binds an identical raw log call to its owning function ancestry', () => {
    const call = `try { work(); } catch (err) {
      app.log.error({ err }, 'history-sync failed');
    }`;
    const background = rawThrowableLoggerFindings(
      'same-file.ts',
      `function backgroundWorker() { ${call} }`,
    );
    const request = rawThrowableLoggerFindings(
      'same-file.ts',
      `function requestHandler() { ${call} }`,
    );

    expect(background).toHaveLength(1);
    expect(request).toHaveLength(1);
    expect(background[0]).not.toBe(request[0]);
  });

  it('stores a stable Studio reversal reason instead of provider detail', async () => {
    const compensate = vi.fn(async () => 'refunded' as const);

    await expect(recordStudioReversal(SECRET_CODE, SENSITIVE, compensate))
      .resolves.toBe('refunded');
    expect(compensate).toHaveBeenCalledWith({
      errorCode: 'internal_error',
      errorMessage: 'Studio generation failed',
    });
    expect(JSON.stringify(compensate.mock.calls)).not.toContain(SENSITIVE);
    expect(JSON.stringify(compensate.mock.calls)).not.toContain(SECRET_CODE);
  });

  it('clamps an explicit route reply that bypasses errorEnvelope and sendError', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerApiErrorHandler(app, { bodyLimitBytes: 1_024 });
    app.get('/raw-provider-failure', async (_request, reply) => {
      reply.headers({
        'accept-ranges': 'bytes',
        'content-encoding': 'gzip',
        'content-range': 'bytes 0-9/10',
        digest: 'sha-256=stale',
        etag: '"stale"',
        'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
        'retry-after': '30',
        'x-content-type-options': 'nosniff',
      });
      return reply.code(502).send({
        error: { code: 'provider_error', message: SENSITIVE, statusCode: 502 },
        providerDetail: SENSITIVE,
      });
    });

    const response = await app.inject({ method: 'GET', url: '/raw-provider-failure' });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        code: 'provider_error',
        message: 'Upstream service unavailable',
        statusCode: 502,
      },
    });
    expect(response.body).not.toContain(SENSITIVE);
    expect(response.headers['accept-ranges']).toBeUndefined();
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers['content-range']).toBeUndefined();
    expect(response.headers.digest).toBeUndefined();
    expect(response.headers.etag).toBeUndefined();
    expect(response.headers['last-modified']).toBeUndefined();
    expect(response.headers['retry-after']).toBe('30');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(Number(response.headers['content-length'])).toBe(Buffer.byteLength(response.body));
  });

  it('does not reserialize a canonical 5xx envelope or disturb safe headers', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerApiErrorHandler(app, { bodyLimitBytes: 1_024 });
    app.get('/canonical', async (_request, reply) => {
      reply.header('retry-after', '30');
      return reply
        .code(503)
        .send(errorEnvelope(503, 'agent_provision_failed', SENSITIVE));
    });

    const response = await app.inject({ method: 'GET', url: '/canonical' });

    expect(response.headers['retry-after']).toBe('30');
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({
      error: {
        code: 'agent_provision_failed',
        message: 'Service temporarily unavailable',
        statusCode: 503,
      },
    });
  });

  it('preserves only the reviewed machine-readable unhealthy health schema', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerApiErrorHandler(app, { bodyLimitBytes: 1_024 });
    app.get('/health', async (_request, reply) => reply.code(503).send({
      ok: false,
      versions: { api: '0.1.0', node: 'v24.1.0', fastify: '5.4.0' },
      database: null,
      schema: {
        status: 'missing_migrations',
        expectedMigration: '0033_session_share_links',
        expectedCount: 34,
        appliedCount: 33,
        missingCount: 1,
        unexpectedCount: 0,
      },
    }));

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      schema: { status: 'missing_migrations', missingCount: 1 },
    });
    expect(response.body).not.toContain(SENSITIVE);
  });

  it('rejects free-form detail smuggled into an unhealthy health body', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerApiErrorHandler(app, { bodyLimitBytes: 1_024 });
    app.get('/health', async (_request, reply) => reply.code(503).send({
      ok: false,
      versions: { api: '0.1.0', node: 'v24.1.0', fastify: '5.4.0' },
      database: null,
      schema: {
        status: 'database_unavailable',
        expectedMigration: SENSITIVE,
        expectedCount: 34,
        appliedCount: null,
        missingCount: null,
        unexpectedCount: null,
      },
    }));

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.json()).toEqual({
      error: {
        code: 'internal_error',
        message: 'Service temporarily unavailable',
        statusCode: 503,
      },
    });
    expect(response.body).not.toContain(SENSITIVE);
  });

  it('keeps named provider and repair logs on the safe metadata seam', async () => {
    const [studio, agents, server] = await Promise.all([
      readFile(new URL('../src/routes/studio.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/routes/agents.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/server.ts', import.meta.url), 'utf8'),
    ]);

    expect(studio).not.toMatch(/tts fallback failed:.*String\(fallbackErr\)/);
    expect(studio).not.toMatch(/tool invoke failed:.*String\(err\)/);
    expect(studio).toMatch(
      /logSafeRequestError\([\s\S]{0,160}fallbackErr[\s\S]{0,160}'studio: tts fallback failed'/,
    );
    expect(studio).toMatch(
      /logSafeRequestError\([\s\S]{0,160}\berr,[\s\S]{0,160}'studio: tool invocation failed'/,
    );
    expect(agents).not.toMatch(/req\.log\.error\(\{ err \}, `repair failed/);
    expect(agents).not.toMatch(/req\.log\.error\(\{ err \}, `import provisioning failed/);
    expect(agents).toMatch(/logSafeRequestError\([\s\S]{0,120}\{ accountId: account\.id \}/);
    expect(agents).toMatch(/logSafeRequestError\([\s\S]{0,160}created\.account\.id/);
    expect(server).not.toMatch(
      /req\.log\.error\(\{ err \}, 'legacy media visibility check failed'/,
    );
    expect(server).toMatch(
      /logSafeRequestError\(req\.log, err, \{\}, 'legacy media visibility check failed'\)/,
    );
  });

  it('keeps an actionable ApiError 4xx message through the production handler', async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    registerApiErrorHandler(app, { bodyLimitBytes: 1_024 });
    app.get('/conflict', async () => {
      throw new ApiError(409, 'write_conflict', 'Reload before saving');
    });

    const response = await app.inject({ method: 'GET', url: '/conflict' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: { code: 'write_conflict', message: 'Reload before saving', statusCode: 409 },
    });
  });
});
