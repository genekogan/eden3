import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DailyCapExceededError,
  InsufficientMannaError,
  CostTableError,
  costFromParams,
  credit,
  debit,
  getEnv,
  mannaForEstimate,
  reverseReservation,
  type CostEstimate,
  type CostProvider,
  type CostUnit,
  type PricedAction,
} from '@eden3/core';
import { db, usageEvents } from '@eden3/db';
import {
  GatewayHttpError,
  GatewayToolError,
  OpenClawToolsClient,
  type ToolInvokeParams,
  type ToolInvokeResult,
} from '@eden3/gateway';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ApiError, sendError } from '../errors';
import { MediaPipeline, type AttachmentKind } from '../services/media-pipeline';
import {
  MediaClaimTimeoutError,
  MediaWatcher,
  type MediaClaim,
  type MediaClaimOptions,
} from '../workers/media-watcher';

/**
 * Studio — direct tool invocation (no chat session).
 *
 *   GET  /studio/tools     — the four media tools + manna pricing.
 *   POST /studio/generate  — {tool, args:{prompt|text, …}} → {creationId, url}.
 *
 * Generation flow: requireAuth → debit the caller up front (refund-safe key
 * `studio:<uuid>`) → register a media claim on the watcher (the "dir
 * snapshot": only files that land AFTER the claim can match) → invoke the
 * tool via the gateway tools client as agent "main" in a per-request gateway
 * session → await BOTH the invocation and claimed file under the same
 * wall-clock budget → ingest WITHOUT a session (creation belongs to the
 * caller) → {creationId, url}. Any failure after the debit refunds it;
 * gateway errors map to 502, a missing/late file to 504.
 *
 * Known correlation limit (same as the watcher's): the gateway gives no
 * task→file mapping, so a file from a concurrent generation of the same kind
 * can be claimed by the wrong request. If the tool run fails silently, we
 * time out, refund, and — should the file land even later — the watcher
 * parks it in media_assets. Documented in workers/media-watcher.ts.
 */

// ---------------------------------------------------------------------------
// Tool catalog
// ---------------------------------------------------------------------------

export const STUDIO_TOOL_NAMES = [
  'image_generate',
  'video_generate',
  'music_generate',
  'tts',
] as const;
export type StudioToolName = (typeof STUDIO_TOOL_NAMES)[number];

/** Attachment kinds a tool's output may claim (music/tts both land as audio). */
const TOOL_CLAIM_KINDS: Record<StudioToolName, AttachmentKind[]> = {
  image_generate: ['image'],
  video_generate: ['video'],
  music_generate: ['audio'],
  tts: ['audio'],
};

/** Wall-clock budget to wait for the generated file, per tool. */
export const GENERATION_TIMEOUTS_MS: Record<StudioToolName, number> = {
  image_generate: 120_000,
  video_generate: 600_000,
  music_generate: 300_000,
  tts: 120_000,
};

interface StudioMeteringSpec {
  action: PricedAction;
  provider: CostProvider;
  model: string;
  unit: CostUnit;
  defaultQuantity: number;
  quantityFromArgs(args: Record<string, unknown>): number;
}

export interface StudioGenerationQuote {
  tool: StudioToolName;
  action: PricedAction;
  provider: CostProvider;
  model: string;
  tableVersion: string;
  units: Partial<Record<CostUnit, number>>;
  costUsd: number;
  manna: number;
  estimated: boolean;
  lineItems: Array<{
    unit: CostUnit;
    quantity: number;
    usdPerUnit: number;
    costUsd: number;
    estimated?: true;
  }>;
}

function numericDuration(
  args: Record<string, unknown>,
  opts: { fallback: number; min: number; max: number },
): number {
  const raw = args.duration;
  const duration = typeof raw === 'number' && Number.isFinite(raw) ? raw : opts.fallback;
  if (duration < opts.min || duration > opts.max) {
    throw new RangeError(`duration must be between ${opts.min} and ${opts.max} seconds`);
  }
  return duration;
}

function textLength(args: Record<string, unknown>): number {
  const raw = typeof args.text === 'string' ? args.text : typeof args.prompt === 'string' ? args.prompt : '';
  const text = raw.trim();
  if (text.length === 0) throw new RangeError('text is required for tts metering');
  return text.length;
}

/**
 * Image model tiers (repriced 2026-07-10): the default is the cheap
 * flux-dev route (34 manna — eden1's `create` averaged ~28 manna, so this
 * restores familiar purchasing power); premium models are explicit opt-ins
 * labeled with their real price. `openclawModel` is the per-request
 * `model` override passed to OpenClaw's image_generate tool.
 */
export const IMAGE_MODEL_OPTIONS = {
  'flux-dev': {
    label: 'Standard · Flux',
    description: 'Fast, dependable image model — the default.',
    provider: 'fal' as CostProvider,
    model: 'fal-ai/flux/dev',
    openclawModel: 'fal/fal-ai/flux/dev',
  },
  'gemini-pro': {
    label: 'Premium · Gemini 3 Pro',
    description: 'Top-tier image quality at a premium price.',
    provider: 'google' as CostProvider,
    model: 'gemini-3-pro-image-preview',
    openclawModel: 'google/gemini-3-pro-image-preview',
  },
} as const;
export type ImageModelKey = keyof typeof IMAGE_MODEL_OPTIONS;
export const DEFAULT_IMAGE_MODEL: ImageModelKey = 'flux-dev';

function imageModelOption(args: Record<string, unknown>): (typeof IMAGE_MODEL_OPTIONS)[ImageModelKey] {
  const raw = typeof args.model === 'string' ? args.model : DEFAULT_IMAGE_MODEL;
  const option = IMAGE_MODEL_OPTIONS[raw as ImageModelKey];
  if (!option) {
    throw new RangeError(
      `unknown image model "${raw}" — expected one of: ${Object.keys(IMAGE_MODEL_OPTIONS).join(', ')}`,
    );
  }
  return option;
}

const STUDIO_METERING: Record<StudioToolName, StudioMeteringSpec> = {
  image_generate: {
    action: 'image',
    provider: IMAGE_MODEL_OPTIONS[DEFAULT_IMAGE_MODEL].provider,
    model: IMAGE_MODEL_OPTIONS[DEFAULT_IMAGE_MODEL].model,
    unit: 'image',
    defaultQuantity: 1,
    quantityFromArgs: () => 1,
  },
  video_generate: {
    action: 'video',
    provider: 'fal',
    model: 'fal-ai/kling-video/v3/pro/text-to-video',
    unit: 'video_second',
    defaultQuantity: 5,
    quantityFromArgs: (args) => numericDuration(args, { fallback: 5, min: 2, max: 10 }),
  },
  music_generate: {
    action: 'music',
    provider: 'google',
    model: 'lyria-3-clip-preview',
    unit: 'music_clip',
    defaultQuantity: 1,
    quantityFromArgs: () => 1,
  },
  tts: {
    action: 'tts',
    provider: 'elevenlabs',
    model: 'tts',
    unit: 'audio_character',
    defaultQuantity: 120,
    quantityFromArgs: textLength,
  },
};

function quoteFromEstimate(
  tool: StudioToolName,
  spec: StudioMeteringSpec,
  estimate: CostEstimate,
): StudioGenerationQuote {
  return {
    tool,
    action: spec.action,
    provider: estimate.provider,
    model: estimate.model,
    tableVersion: estimate.tableVersion,
    units: Object.fromEntries(estimate.lineItems.map((line) => [line.unit, line.quantity])),
    costUsd: estimate.totalCostUsd,
    manna: mannaForEstimate(estimate),
    estimated: estimate.estimated,
    lineItems: estimate.lineItems.map((line) => ({
      unit: line.unit,
      quantity: line.quantity,
      usdPerUnit: line.usdPerUnit,
      costUsd: line.costUsd,
      ...(line.estimated === true ? { estimated: true } : {}),
    })),
  };
}

export function quoteStudioGeneration(
  tool: StudioToolName,
  args: Record<string, unknown> = {},
): StudioGenerationQuote {
  const spec = STUDIO_METERING[tool];
  // Image is model-aware: args.model selects the billed (and routed) tier.
  const priced =
    tool === 'image_generate'
      ? (() => {
          const option = imageModelOption(args);
          return { ...spec, provider: option.provider, model: option.model };
        })()
      : spec;
  const quantity = priced.quantityFromArgs(args);
  const estimate = costFromParams({
    provider: priced.provider,
    model: priced.model,
    units: { [priced.unit]: quantity },
  });
  return quoteFromEstimate(tool, priced, estimate);
}

function defaultQuote(tool: StudioToolName): StudioGenerationQuote {
  const spec = STUDIO_METERING[tool];
  const estimate = costFromParams({
    provider: spec.provider,
    model: spec.model,
    units: { [spec.unit]: spec.defaultQuantity },
  });
  return quoteFromEstimate(tool, spec, estimate);
}

const STUDIO_PRICING = Object.fromEntries(
  STUDIO_TOOL_NAMES.map((tool) => [tool, defaultQuote(tool).manna]),
) as Record<StudioToolName, number>;

/** Shape consumed by apps/web studio catalog (lib/types.ts StudioTool). */
export const STUDIO_TOOLS = [
  {
    name: 'image_generate',
    description: 'Generate an image from a text prompt.',
    outputType: 'image',
    costManna: STUDIO_PRICING.image_generate,
    metering: defaultQuote('image_generate'),
    // Model tiers with real prices — the web renders these as a picker.
    models: Object.entries(IMAGE_MODEL_OPTIONS).map(([key, option]) => ({
      key,
      label: option.label,
      description: option.description,
      costManna: quoteStudioGeneration('image_generate', { model: key }).manna,
      default: key === DEFAULT_IMAGE_MODEL,
    })),
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to depict.' },
        model: {
          type: 'string',
          enum: Object.keys(IMAGE_MODEL_OPTIONS),
          default: DEFAULT_IMAGE_MODEL,
          description: 'Image model tier (premium tiers cost more).',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'video_generate',
    description: 'Generate a short video clip from a text prompt.',
    outputType: 'video',
    costManna: STUDIO_PRICING.video_generate,
    metering: defaultQuote('video_generate'),
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Scene, motion, mood.' },
        duration: {
          type: 'number',
          description: 'Clip length in seconds.',
          minimum: 2,
          maximum: 10,
          default: 5,
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'music_generate',
    description: 'Compose a piece of music from a description.',
    outputType: 'audio',
    costManna: STUDIO_PRICING.music_generate,
    metering: defaultQuote('music_generate'),
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Genre, tempo, instrumentation.' },
        duration: {
          type: 'number',
          description: 'Track length in seconds.',
          minimum: 5,
          maximum: 120,
          default: 30,
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'tts',
    description: 'Speak text aloud in an expressive voice.',
    outputType: 'audio',
    costManna: STUDIO_PRICING.tts,
    metering: defaultQuote('tts'),
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The words to speak.' } },
      required: ['text'],
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const generateBodySchema = z.object({
  tool: z.enum(STUDIO_TOOL_NAMES),
  args: z
    .object({
      prompt: z.string().trim().min(1).optional(),
      text: z.string().trim().min(1).optional(),
    })
    .passthrough()
    .refine((args) => args.prompt !== undefined || args.text !== undefined, {
      message: 'args.prompt (or args.text for tts) is required',
    }),
});

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

/** The slice of OpenClawToolsClient the route needs (fakes stay trivial). */
export interface ToolsInvoker {
  invokeTool(params: ToolInvokeParams): Promise<ToolInvokeResult>;
}

/** The slice of MediaWatcher the route needs. */
export interface MediaClaimSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  claimNext(opts: MediaClaimOptions): MediaClaim;
}

export interface TtsFallbackParams {
  args: Record<string, unknown>;
  requestId: string;
  timeoutMs: number;
}

export interface TtsFallbackFile {
  path: string;
}

export type TtsFallbackGenerator = (params: TtsFallbackParams) => Promise<TtsFallbackFile>;

export interface StudioDeps {
  pipeline?: MediaPipeline;
  watcher?: MediaClaimSource;
  /** Lazy so the server can boot (and GET /tools work) without a token. */
  getToolsClient?: () => ToolsInvoker;
  /** OpenClaw agent the tools are invoked through (default "main"). */
  agentId?: string;
  timeoutsMs?: Partial<Record<StudioToolName, number>>;
  /** TEST SEAM: exact-pot reversal; production uses the core ledger primitive. */
  reverseDebit?: typeof reverseReservation;
  /**
   * OpenClaw 2026.6.10 exposes TTS as a chat/control command, not as a direct
   * `/tools/invoke` media tool. Studio keeps the OpenClaw path first, then
   * falls back to the same ElevenLabs provider only when that direct tool is
   * missing. Tests may pass `null` to disable the fallback.
   */
  ttsFallback?: TtsFallbackGenerator | null;
}

export interface StudioRoutesOptions {
  deps?: StudioDeps;
}

function isMissingTtsInvoke(err: unknown, tool: StudioToolName): boolean {
  return (
    tool === 'tts' &&
    err instanceof GatewayHttpError &&
    err.status === 404 &&
    err.message.includes('/tools/invoke')
  );
}

async function elevenLabsTtsFallback({
  args,
  requestId,
  timeoutMs,
}: TtsFallbackParams): Promise<TtsFallbackFile> {
  const text = typeof args.text === 'string' ? args.text.trim() : typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (text.length === 0) throw new ApiError(400, 'bad_request', 'text is required for tts');

  const apiKey = process.env.ELEVENLABS_API_KEY ?? process.env.ELEVEN_API_KEY;
  if (!apiKey) {
    throw new ApiError(503, 'tts_not_configured', 'ElevenLabs API key is not configured');
  }
  const voiceId =
    process.env.ELEVENLABS_VOICE_ID ??
    process.env.ELEVEN_VOICE_ID ??
    'JBFqnCBsd6RMkjVDRZzb';
  const modelId = process.env.ELEVENLABS_TTS_MODEL ?? 'eleven_multilingual_v2';
  const baseUrl = (process.env.ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io').replace(/\/+$/, '');
  const url = `${baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
  const signal = AbortSignal.timeout(timeoutMs);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'audio/mpeg',
      'content-type': 'application/json',
      'xi-api-key': apiKey,
    },
    body: JSON.stringify({ text, model_id: modelId }),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ElevenLabs TTS responded ${res.status}${detail ? `: ${detail.slice(0, 400)}` : ''}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length === 0) throw new Error('ElevenLabs TTS returned an empty audio file');

  const dir = await mkdtemp(path.join(tmpdir(), 'eden3-tts-'));
  const file = path.join(dir, `${requestId}.mp3`);
  await writeFile(file, audio);
  return { path: file };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const studioRoutes: FastifyPluginAsync<StudioRoutesOptions> = async (app, opts) => {
  const deps = opts.deps ?? {};
  // Root-scope decoration from events-bus.ts; undefined on bare test apps.
  const bus = (app.eventsBus as typeof app.eventsBus | undefined) ?? null;
  const pipeline = deps.pipeline ?? new MediaPipeline({ bus, logger: app.log });
  const agentId = deps.agentId ?? 'main';
  const reverseDebit = deps.reverseDebit ?? reverseReservation;
  const ttsFallback = deps.ttsFallback === undefined ? elevenLabsTtsFallback : deps.ttsFallback;

  // The process should run exactly ONE watcher. Until the chat pipeline
  // lands its own wiring, the studio plugin owns it: created here, started
  // lazily on the first generate, stopped when the server closes. Injected
  // watchers (tests, future shared wiring) are left unmanaged.
  let watcher = deps.watcher ?? null;
  const ownWatcher = watcher === null;
  if (watcher === null) {
    watcher = new MediaWatcher({ pipeline, logger: app.log });
  }
  const claimSource = watcher;
  if (ownWatcher) {
    app.addHook('onClose', async () => {
      await claimSource.stop();
    });
  }

  let cachedClient: ToolsInvoker | null = null;
  const getToolsClient =
    deps.getToolsClient ??
    ((): ToolsInvoker => {
      if (cachedClient) return cachedClient;
      const env = getEnv();
      const token = env.OPENCLAW_GATEWAY_TOKEN;
      if (!token) {
        throw new ApiError(
          503,
          'gateway_not_configured',
          'OPENCLAW_GATEWAY_TOKEN is not set — studio generation is unavailable',
        );
      }
      cachedClient = new OpenClawToolsClient({ baseUrl: env.OPENCLAW_BASE_URL, token });
      return cachedClient;
    });

  // --- GET /studio/tools --------------------------------------------------
  app.get('/tools', async () => ({ tools: STUDIO_TOOLS, pricing: STUDIO_PRICING }));

  // --- POST /studio/quote -------------------------------------------------
  app.post('/quote', async (req, reply) => {
    const body = generateBodySchema.parse(req.body);
    try {
      return { quote: quoteStudioGeneration(body.tool, body.args) };
    } catch (err) {
      if (err instanceof RangeError) {
        return sendError(reply, 400, 'bad_request', err.message);
      }
      if (err instanceof CostTableError) {
        return sendError(reply, 500, 'metering_not_configured', err.message);
      }
      throw err;
    }
  });

  // --- POST /studio/generate -----------------------------------------------
  app.post('/generate', { preHandler: app.requireAuth }, async (req, reply) => {
    const body = generateBodySchema.parse(req.body);
    const account = req.account;
    if (!account) return sendError(reply, 401, 'unauthorized', 'Authentication required');

    let quote: StudioGenerationQuote;
    try {
      quote = quoteStudioGeneration(body.tool, body.args);
    } catch (err) {
      if (err instanceof RangeError) {
        return sendError(reply, 400, 'bad_request', err.message);
      }
      if (err instanceof CostTableError) {
        return sendError(reply, 500, 'metering_not_configured', err.message);
      }
      throw err;
    }

    const action = quote.action;
    const timeoutMs = deps.timeoutsMs?.[body.tool] ?? GENERATION_TIMEOUTS_MS[body.tool];
    const startedAtMs = Date.now();
    const requestId = randomUUID();
    const idempotencyKey = `studio:${requestId}:reserve`;
    const gatewaySessionKey = `eden3:studio:${requestId}`;

    // 1. Debit up front — refunded on any downstream failure. Studio spends
    // count toward the same Q7 daily ceiling as chat turns (checked inside
    // the debit transaction, race-free) — previously studio bypassed the cap.
    let reservedSubscriptionManna = 0;
    try {
      const debited = await debit({
        accountId: account.accountId,
        amount: quote.manna,
        type: `spend:${action}`,
        idempotencyKey,
        dailyCap: { limit: getEnv().DAILY_MANNA_SPEND_CAP_PER_USER },
      });
      // Preserve the debit's exact pot split for any downstream reversal.
      // The reservation key is request-unique, while reverseReservation's
      // refund leg is idempotent if an in-process retry reaches it twice.
      reservedSubscriptionManna = debited.subscriptionDrawn ?? 0;
    } catch (err) {
      if (err instanceof InsufficientMannaError) {
        return sendError(
          reply,
          402,
          'insufficient_manna',
          `${body.tool} costs ${quote.manna} manna; you have ${err.available}`,
        );
      }
      if (err instanceof DailyCapExceededError) {
        return sendError(
          reply,
          429,
          'daily_manna_cap_exceeded',
          `Daily manna cap reached: ${err.spentToday} of ${err.cap} manna spent today. The cap resets at midnight UTC.`,
        );
      }
      throw err;
    }

    const settleReserve = async (): Promise<{
      status: 'settled' | 'failed';
      reservedManna: number;
      meteredManna: number;
      adjustmentManna: number;
      chargedManna: number;
      transactionId: string | null;
      alreadyApplied: boolean;
      error?: string;
    }> => {
      const adjustmentManna = quote.manna - quote.manna;
      if (adjustmentManna === 0) {
        return {
          status: 'settled',
          reservedManna: quote.manna,
          meteredManna: quote.manna,
          adjustmentManna,
          chargedManna: quote.manna,
          transactionId: null,
          alreadyApplied: false,
        };
      }
      try {
        if (adjustmentManna > 0) {
          const adjusted = await debit({
            accountId: account.accountId,
            amount: adjustmentManna,
            type: `spend:${action}:settle`,
            idempotencyKey: `${idempotencyKey}:settle`,
          });
          return {
            status: 'settled',
            reservedManna: quote.manna,
            meteredManna: quote.manna,
            adjustmentManna,
            chargedManna: quote.manna,
            transactionId: adjusted.transaction.id,
            alreadyApplied: adjusted.alreadyApplied,
          };
        }
        const adjusted = await credit({
          accountId: account.accountId,
          amount: Math.abs(adjustmentManna),
          type: `refund:${action}:settle`,
          idempotencyKey: `${idempotencyKey}:settle:refund`,
        });
        return {
          status: 'settled',
          reservedManna: quote.manna,
          meteredManna: quote.manna,
          adjustmentManna,
          chargedManna: quote.manna,
          transactionId: adjusted.transaction.id,
          alreadyApplied: adjusted.alreadyApplied,
        };
      } catch (err) {
        return {
          status: 'failed',
          reservedManna: quote.manna,
          meteredManna: quote.manna,
          adjustmentManna,
          chargedManna: quote.manna - adjustmentManna,
          transactionId: null,
          alreadyApplied: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };

    let usageEventRecorded = false;
    const recordUsageEvent = async (record: {
      status: 'completed' | 'error';
      creationId?: string | null;
      chargedManna: number;
      costUsd: number;
      settlement?: Awaited<ReturnType<typeof settleReserve>> | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    }): Promise<void> => {
      if (usageEventRecorded) return;
      usageEventRecorded = true;
      try {
        await db.insert(usageEvents).values({
          eventType: 'studio_generation',
          status: record.status,
          userId: account.accountId,
          agentId: null,
          sessionId: null,
          messageId: null,
          turnId: null,
          provider: quote.provider,
          model: quote.model,
          tableVersion: quote.tableVersion,
          promptTokens: null,
          completionTokens: null,
          cachedTokens: null,
          totalTokens: null,
          costUsd: record.costUsd.toFixed(8),
          manna: record.chargedManna,
          latencyMs: Date.now() - startedAtMs,
          errorCode: record.errorCode ?? null,
          errorMessage: record.errorMessage ?? null,
          metadata: {
            tool: body.tool,
            args: body.args,
            quote,
            settlement: record.settlement ?? null,
            reserveIdempotencyKey: idempotencyKey,
            creationId: record.creationId ?? null,
          },
        });
      } catch (err) {
        req.log.error(`studio: usage event insert failed for ${idempotencyKey}: ${String(err)}`);
      }
    };

    type RefundOutcome = { status: 'refunded' } | { status: 'refund_pending' };
    const reverseFailedGeneration = async (): Promise<RefundOutcome> => {
      try {
        await reverseDebit({
          reservationKey: idempotencyKey,
          reservedSubscriptionManna,
          type: `refund:${action}`,
        });
        return { status: 'refunded' };
      } catch (refundErr) {
        req.log.error(`studio: refund of ${idempotencyKey} failed: ${String(refundErr)}`);
        return { status: 'refund_pending' };
      }
    };

    const requireReversal = async (): Promise<void> => {
      const outcome = await reverseFailedGeneration();
      if (outcome.status === 'refunded') return;
      await recordUsageEvent({
        status: 'error',
        chargedManna: quote.manna,
        costUsd: quote.costUsd,
        errorCode: 'refund_pending',
        errorMessage: 'Studio generation failed and its manna reversal requires retry',
      });
      throw new ApiError(
        503,
        'refund_pending',
        'Generation failed and your manna refund is pending. Please retry later or contact support.',
      );
    };

    // 2. Claim BEFORE invoking (the claim is the dir snapshot: only files
    //    landing after this point can match), then kick off the tool.
    //    claimSource.start() can throw (watcher/chokidar startup) — that is
    //    AFTER the debit, so it must refund too, or the manna orphans with no
    //    client-visible id to replay.
    let claim: MediaClaim;
    try {
      await claimSource.start();
      claim = claimSource.claimNext({ kinds: TOOL_CLAIM_KINDS[body.tool], timeoutMs });
    } catch (err) {
      await requireReversal();
      await recordUsageEvent({
        status: 'error',
        chargedManna: 0,
        costUsd: 0,
        errorCode: 'watcher_start_failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // 3. Wait for BOTH the invocation and generated file. OpenClaw media
    // tools can finish by writing the file before invokeTool() resolves, and
    // old queued completions from a reused gateway session can arrive late.
    // The unique sessionKey keeps the gateway context clean; the shared timer
    // keeps the HTTP request/refund bounded even if the gateway call hangs.
    let file;
    const controller = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        claim.cancel();
        controller.abort();
        reject(new MediaClaimTimeoutError(timeoutMs));
      }, timeoutMs);
      timeout.unref();
    });
    try {
      // Image tier keys map to OpenClaw's per-request `model` override
      // (provider/model ref) so the routed model matches the billed one.
      const invokeArgs =
        body.tool === 'image_generate'
          ? { ...body.args, model: imageModelOption(body.args).openclawModel }
          : body.args;
      const invoke = getToolsClient().invokeTool({
        tool: body.tool,
        args: invokeArgs,
        agentId,
        sessionKey: gatewaySessionKey,
        signal: controller.signal,
      });
      const [, claimedFile] = await Promise.race([
        Promise.all([invoke, claim.promise]),
        timeoutPromise,
      ]);
      file = claimedFile;
    } catch (err) {
      claim.cancel();
      controller.abort();
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (ttsFallback !== null && isMissingTtsInvoke(err, body.tool)) {
        try {
          file = await ttsFallback({ args: body.args, requestId, timeoutMs });
        } catch (fallbackErr) {
          await requireReversal();
          const detail =
            fallbackErr instanceof ApiError
              ? fallbackErr.message
              : fallbackErr instanceof Error
                ? fallbackErr.message
                : 'tts provider failed';
          await recordUsageEvent({
            status: 'error',
            chargedManna: 0,
            costUsd: 0,
            errorCode: fallbackErr instanceof ApiError ? fallbackErr.code : 'provider_error',
            errorMessage: detail,
          });
          if (fallbackErr instanceof ApiError) {
            return sendError(reply, fallbackErr.statusCode, fallbackErr.code, detail);
          }
          req.log.error(`studio: tts fallback failed: ${String(fallbackErr)}`);
          return sendError(reply, 502, 'provider_error', `tts failed: ${detail}`);
        }
      } else {
      await requireReversal();
      if (timedOut || err instanceof MediaClaimTimeoutError) {
        await recordUsageEvent({
          status: 'error',
          chargedManna: 0,
          costUsd: 0,
          errorCode: 'generation_timeout',
          errorMessage: `${body.tool} did not produce a file within ${Math.round(timeoutMs / 1000)}s`,
        });
        return sendError(
          reply,
          504,
          'generation_timeout',
          `${body.tool} did not produce a file within ${Math.round(timeoutMs / 1000)}s — manna refunded`,
        );
      }
      if (err instanceof ApiError) throw err;
      const detail =
        err instanceof GatewayHttpError || err instanceof GatewayToolError
          ? err.message
          : 'gateway invocation failed';
      req.log.error(`studio: ${body.tool} invoke failed: ${String(err)}`);
      await recordUsageEvent({
        status: 'error',
        chargedManna: 0,
        costUsd: 0,
        errorCode: 'gateway_error',
        errorMessage: detail,
      });
      return sendError(reply, 502, 'gateway_error', `${body.tool} failed: ${detail}`);
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    // 4. Ingest with NO session: the creation belongs to the caller.
    try {
      const result = await pipeline.ingestFile(file.path, {
        userId: account.accountId,
        tool: body.tool,
        args: body.args,
      });
      if (!result.creation) {
        throw new Error('studio: ingest produced no creation row');
      }
      const settlement = await settleReserve();
      await recordUsageEvent({
        status: 'completed',
        creationId: result.creation.id,
        chargedManna: settlement.chargedManna,
        costUsd: quote.costUsd,
        settlement,
      });
      return {
        creationId: result.creation.id,
        url: result.url,
        mime: result.mime,
        metering: quote,
        settlement,
      };
    } catch (err) {
      await requireReversal();
      await recordUsageEvent({
        status: 'error',
        chargedManna: 0,
        costUsd: quote.costUsd,
        errorCode: 'ingest_failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });
};
