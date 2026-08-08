import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LocalMediaStore, type AuthProvider } from '@eden3/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerAuth } from '../src/auth-plugin';
import { ApiError, errorEnvelope } from '../src/errors';
import {
  parseStudioGenerationRequest,
  quoteStudioGeneration,
  studioProviderArgs,
  studioRoutes,
} from '../src/routes/studio';
import { MediaPipeline } from '../src/services/media-pipeline';

describe('Studio closed quote/wire contract', () => {
  it('maps an image catalog key to only the canonical provider override', () => {
    const request = parseStudioGenerationRequest({
      tool: 'image_generate',
      args: { prompt: '  glass city  ', model: 'gemini-pro' },
    });

    expect(request.args).toEqual({ prompt: 'glass city', model: 'gemini-pro' });
    expect(studioProviderArgs(request)).toEqual({
      prompt: 'glass city',
      model: 'google/gemini-3-pro-image-preview',
    });
    expect(quoteStudioGeneration(request.tool, request.args)).toMatchObject({
      provider: 'google',
      model: 'gemini-3-pro-image-preview',
    });
  });

  it.each([2, 5, 10])(
    'materializes the video duration and keeps quote quantity == wire at %ss',
    (duration) => {
      const request = parseStudioGenerationRequest({
        tool: 'video_generate',
        args: { prompt: 'a moving prism', duration },
      });
      const wire = studioProviderArgs(request);
      const quote = quoteStudioGeneration(request.tool, request.args);

      expect(wire).toEqual({ prompt: 'a moving prism', duration });
      expect(quote.units.video_second).toBe(duration);
      expect(quote.lineItems).toEqual([
        expect.objectContaining({ unit: 'video_second', quantity: duration }),
      ]);
    },
  );

  it('materializes the same default video duration for quote and wire', () => {
    const request = parseStudioGenerationRequest({
      tool: 'video_generate',
      args: { prompt: 'default clip' },
    });

    expect(request.tool).toBe('video_generate');
    if (request.tool !== 'video_generate') throw new Error('unexpected parser branch');
    expect(request.args.duration).toBeUndefined();
    expect(studioProviderArgs(request)).toEqual({ prompt: 'default clip', duration: 5 });
    expect(quoteStudioGeneration(request.tool, request.args).units.video_second).toBe(5);
  });

  it('meters the exact canonical TTS text forwarded to either provider path', () => {
    const request = parseStudioGenerationRequest({
      tool: 'tts',
      args: { text: '  Speak exactly this.  ' },
    });
    const wire = studioProviderArgs(request);
    const quote = quoteStudioGeneration(request.tool, request.args);

    expect(wire).toEqual({ text: 'Speak exactly this.' });
    expect(quote.units.audio_character).toBe((wire.text as string).length);
  });

  it('preserves the bounded current-UI music duration under fixed per-clip pricing', () => {
    const request = parseStudioGenerationRequest({
      tool: 'music_generate',
      args: { prompt: 'bright strings', duration: 120 },
    });

    expect(studioProviderArgs(request)).toEqual({ prompt: 'bright strings', duration: 120 });
    expect(quoteStudioGeneration(request.tool, request.args).units.music_clip).toBe(1);
  });
});

describe('Studio rejects cost-driving arg escapes before money/provider work', () => {
  let app: FastifyInstance;
  let providerFactoryCalls = 0;

  const authProvider: AuthProvider = {
    async getSession() {
      return {
        accountId: '00000000-0000-4000-8000-000000000001',
        username: 'studio-args-test',
        isAdmin: false,
      };
    },
  };

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof ApiError) {
        return reply.code(err.statusCode).send(errorEnvelope(err.statusCode, err.code, err.message));
      }
      if (err instanceof ZodError) {
        return reply.code(400).send(errorEnvelope(400, 'bad_request', 'invalid body'));
      }
      return reply.code(500).send(errorEnvelope(500, 'internal_error', 'internal error'));
    });
    registerAuth(app, { provider: authProvider });
    await app.register(studioRoutes, {
      prefix: '/studio',
      deps: {
        pipeline: new MediaPipeline({
          store: new LocalMediaStore({
            mediaDir: mkdtempSync(path.join(tmpdir(), 'eden3-studio-args-')),
            baseUrl: 'http://media.test/media',
          }),
        }),
        watcher: {
          async start() {},
          async stop() {},
          claimNext() {
            throw new Error('watcher must not start for a rejected body');
          },
        },
        getToolsClient: () => {
          providerFactoryCalls += 1;
          throw new Error('provider must not be constructed for a rejected body');
        },
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const escapeCases = [
    ['image count', 'image_generate', { prompt: 'x', count: 8 }],
    ['image quality', 'image_generate', { prompt: 'x', quality: 'hd' }],
    ['image resolution', 'image_generate', { prompt: 'x', resolution: '4096x4096' }],
    ['image duration', 'image_generate', { prompt: 'x', duration: 10 }],
    ['raw image provider model', 'image_generate', { prompt: 'x', model: 'google/other' }],
    ['video count', 'video_generate', { prompt: 'x', duration: 5, count: 2 }],
    ['video quality', 'video_generate', { prompt: 'x', duration: 5, quality: 'pro' }],
    ['video resolution', 'video_generate', { prompt: 'x', duration: 5, resolution: '4k' }],
    ['video model', 'video_generate', { prompt: 'x', duration: 5, model: 'kling-ultra' }],
    ['music count', 'music_generate', { prompt: 'x', duration: 30, count: 2 }],
    ['music model', 'music_generate', { prompt: 'x', duration: 30, model: 'other' }],
    ['tts duration', 'tts', { text: 'x', duration: 60 }],
    ['tts model', 'tts', { text: 'x', model: 'turbo' }],
    ['tts quality', 'tts', { text: 'x', quality: 'high' }],
  ] as const;

  it.each(escapeCases)('%s fails quote and generation with 400', async (_name, tool, args) => {
    const payload = { tool, args };
    const quote = await app.inject({ method: 'POST', url: '/studio/quote', payload });
    const generate = await app.inject({ method: 'POST', url: '/studio/generate', payload });

    expect(quote.statusCode).toBe(400);
    expect(generate.statusCode).toBe(400);
    expect((quote.json() as { error: { code: string } }).error.code).toBe('bad_request');
    expect((generate.json() as { error: { code: string } }).error.code).toBe('bad_request');
    expect(providerFactoryCalls).toBe(0);
  });

  it.each([
    ['video below minimum', 'video_generate', { prompt: 'x', duration: 1.99 }],
    ['video above maximum', 'video_generate', { prompt: 'x', duration: 10.01 }],
    ['music below minimum', 'music_generate', { prompt: 'x', duration: 4.99 }],
    ['music above maximum', 'music_generate', { prompt: 'x', duration: 120.01 }],
  ] as const)('%s fails closed', async (_name, tool, args) => {
    const quote = await app.inject({
      method: 'POST',
      url: '/studio/quote',
      payload: { tool, args },
    });
    expect(quote.statusCode).toBe(400);
    expect(providerFactoryCalls).toBe(0);
  });
});
