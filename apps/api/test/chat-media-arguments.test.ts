import { describe, expect, it } from 'vitest';

import {
  canonicalChatMediaProviderArgs,
  quoteChatMediaTool,
} from '../src/services/chat-media-authorization';

describe('in-chat image argument normalization', () => {
  it('admits OpenClaw square geometry while retaining the fixed one-image quote', () => {
    const args = {
      prompt: 'a cheerful green rocketship',
      aspectRatio: '1:1',
      size: '1024x1024',
    };
    const quote = quoteChatMediaTool('image_generate', args);
    expect(quote.units).toEqual({ image: 1 });
    expect(canonicalChatMediaProviderArgs('image_generate', args)).toEqual({
      prompt: 'a cheerful green rocketship',
      model: 'fal/fal-ai/flux/dev',
      aspectRatio: '1:1',
    });
  });

  it('normalizes reviewed size hints to bounded aspect-ratio provider requests', () => {
    for (const [size, aspectRatio] of [
      ['1536x1024', '3:2'],
      ['1024x1536', '2:3'],
      ['2048x2048', '1:1'],
      ['3840x2160', '16:9'],
    ]) {
      expect(canonicalChatMediaProviderArgs('image_generate', { prompt: 'x', size })).toEqual({
        prompt: 'x',
        model: 'fal/fal-ai/flux/dev',
        aspectRatio,
      });
    }
  });

  it('accepts OpenClaw one-image and output-format defaults without changing the quote', () => {
    for (const outputFormat of ['png', 'jpeg', 'webp']) {
      const args = { prompt: 'x', count: 1, outputFormat };
      expect(quoteChatMediaTool('image_generate', args).units).toEqual({ image: 1 });
      expect(canonicalChatMediaProviderArgs('image_generate', args)).toEqual({
        prompt: 'x',
        model: 'fal/fal-ai/flux/dev',
        count: 1,
        outputFormat,
      });
    }
  });

  it('fails closed on unpriced, unknown, or conflicting geometry', () => {
    for (const args of [
      { prompt: 'x', size: '4096x4096' },
      { prompt: 'x', aspectRatio: 'freeform' },
      { prompt: 'x', aspectRatio: '16:9', size: '1024x1024' },
      { prompt: 'x', resolution: '4K' },
      { prompt: 'x', count: 2 },
      { prompt: 'x', count: 0 },
      { prompt: 'x', outputFormat: 'gif' },
    ]) {
      expect(() => quoteChatMediaTool('image_generate', args)).toThrow();
    }
  });
});

describe('in-chat image-to-video argument normalization', () => {
  const generatedImage =
    '/tmp/eden-review/openclaw/media/tool-image-generation/image-1---bunny.png';

  it('prices and preserves one generated-image reference on the fixed image-to-video route', () => {
    const args = {
      prompt: 'a bunny hopping gently',
      image: generatedImage,
      durationSeconds: 4,
    };

    expect(quoteChatMediaTool('video_generate', args)).toMatchObject({
      model: 'fal-ai/kling-video/v3/pro/image-to-video',
      units: { video_second: 4 },
      costUsd: 0.448,
    });
    expect(canonicalChatMediaProviderArgs('video_generate', args)).toEqual({
      prompt: 'a bunny hopping gently',
      image: generatedImage,
      durationSeconds: 4,
      model: 'fal/fal-ai/kling-video/v3/pro/image-to-video',
    });
  });

  it('normalizes OpenClaw single-entry images while rejecting ambiguous or unsafe references', () => {
    expect(
      canonicalChatMediaProviderArgs('video_generate', {
        prompt: 'hop',
        images: [generatedImage],
      }),
    ).toMatchObject({ image: generatedImage });

    for (const args of [
      { prompt: 'hop', image: 'https://attacker.invalid/bunny.png' },
      { prompt: 'hop', image: '/etc/passwd' },
      { prompt: 'hop', image: '/tmp/media/tool-image-generation/../private.png' },
      { prompt: 'hop', image: generatedImage, images: [generatedImage] },
      { prompt: 'hop', images: [] },
      { prompt: 'hop', images: [generatedImage, generatedImage] },
      {
        prompt: 'hop',
        image: generatedImage,
        model: 'fal/fal-ai/kling-video/v3/pro/text-to-video',
      },
    ]) {
      expect(() => quoteChatMediaTool('video_generate', args)).toThrow();
    }
  });
});
