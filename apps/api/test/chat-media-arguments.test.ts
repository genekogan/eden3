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
