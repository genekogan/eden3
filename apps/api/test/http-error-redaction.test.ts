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

const SENSITIVE = 'SENSITIVE_5XX_SENTINEL_do_not_expose';
const SECRET_CODE = 'secret_token_value';
const SECRET_ERRNO = 'ESECRET_TOKEN_VALUE';
const SECRET_ERROR_NAME = 'SecretTokenError';

const REVIEWED_BACKGROUND_THROWABLE_LOGS = new Set([
  'server.ts:history-sync failed',
  'server.ts:scheduled task side-error',
  'server.ts:scheduled task recovery side-error',
  'server.ts:turn-reservation reaper side-error',
  'server.ts:studio-reservation reaper side-error',
  'server.ts:chat-media reaper side-error',
  'server.ts:memory dream side-error',
  'server.ts:memory dream scheduler tick failed',
  'server.ts:upload policy event tick failed',
  'server.ts:multipart cleanup tick failed',
  'routes/channels.ts:channel turn stale-refund sweep failed',
]);

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
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const logger = node.expression.expression;
      if (
        (method === 'error' || method === 'warn') &&
        ts.isPropertyAccessExpression(logger) &&
        logger.name.text === 'log' &&
        ts.isIdentifier(logger.expression) &&
        ['app', 'req', 'request'].includes(logger.expression.text)
      ) {
        const messageArg = node.arguments.at(-1);
        const message = messageArg && ts.isStringLiteral(messageArg) ? messageArg.text : '(dynamic)';
        let unsafe = false;
        for (const argument of node.arguments) {
          const inspect = (candidate: ts.Node): void => {
            if (
              ts.isIdentifier(candidate) &&
              ['err', 'error'].includes(candidate.text)
            ) {
              unsafe = true;
            }
            ts.forEachChild(candidate, inspect);
          };
          inspect(argument);
        }
        if (unsafe) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          findings.push(`${filePath}:${line}:${message}`);
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

  it('recursively inventories raw throwable logs and allows only reviewed background sites', async () => {
    const apiSrc = path.resolve(import.meta.dirname, '../src');
    const files = [
      path.join(apiSrc, 'server.ts'),
      ...await typescriptFiles(path.join(apiSrc, 'routes')),
    ];
    const unsafe: string[] = [];
    for (const file of files) {
      const relative = path.relative(apiSrc, file);
      const findings = rawThrowableLoggerFindings(relative, await readFile(file, 'utf8'));
      for (const finding of findings) {
        const [sourceFile, _line, message] = finding.split(':');
        if (!REVIEWED_BACKGROUND_THROWABLE_LOGS.has(`${sourceFile}:${message}`)) {
          unsafe.push(finding);
        }
      }
    }

    expect(unsafe).toEqual([]);
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
