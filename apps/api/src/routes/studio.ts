import { randomUUID } from 'node:crypto';

import {
  InsufficientMannaError,
  PRICING,
  debit,
  getEnv,
  refund,
  type PricedAction,
} from '@eden3/core';
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
 * tool via the gateway tools client as agent "main" → await the claimed file
 * (kind-filtered, per-tool timeout) → ingest WITHOUT a session (creation
 * belongs to the caller) → {creationId, url}. Any failure after the debit
 * refunds it; gateway errors map to 502, a missing file to 504.
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

const TOOL_ACTIONS: Record<StudioToolName, PricedAction> = {
  image_generate: 'image',
  video_generate: 'video',
  music_generate: 'music',
  tts: 'tts',
};

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

/** Shape consumed by apps/web studio catalog (lib/types.ts StudioTool). */
export const STUDIO_TOOLS = [
  {
    name: 'image_generate',
    description: 'Generate an image from a text prompt.',
    outputType: 'image',
    costManna: PRICING.image,
    parameters: {
      type: 'object',
      properties: { prompt: { type: 'string', description: 'What to depict.' } },
      required: ['prompt'],
    },
  },
  {
    name: 'video_generate',
    description: 'Generate a short video clip from a text prompt.',
    outputType: 'video',
    costManna: PRICING.video,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Scene, motion, mood.' },
        duration: { type: 'number', description: 'Clip length in seconds.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'music_generate',
    description: 'Compose a piece of music from a description.',
    outputType: 'audio',
    costManna: PRICING.music,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Genre, tempo, instrumentation.' },
        duration: { type: 'number', description: 'Track length in seconds.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'tts',
    description: 'Speak text aloud in an expressive voice.',
    outputType: 'audio',
    costManna: PRICING.tts,
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

export interface StudioDeps {
  pipeline?: MediaPipeline;
  watcher?: MediaClaimSource;
  /** Lazy so the server can boot (and GET /tools work) without a token. */
  getToolsClient?: () => ToolsInvoker;
  /** OpenClaw agent the tools are invoked through (default "main"). */
  agentId?: string;
  timeoutsMs?: Partial<Record<StudioToolName, number>>;
}

export interface StudioRoutesOptions {
  deps?: StudioDeps;
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
  app.get('/tools', async () => ({ tools: STUDIO_TOOLS, pricing: PRICING }));

  // --- POST /studio/generate -----------------------------------------------
  app.post('/generate', { preHandler: app.requireAuth }, async (req, reply) => {
    const body = generateBodySchema.parse(req.body);
    const account = req.account;
    if (!account) return sendError(reply, 401, 'unauthorized', 'Authentication required');

    const action = TOOL_ACTIONS[body.tool];
    const timeoutMs = deps.timeoutsMs?.[body.tool] ?? GENERATION_TIMEOUTS_MS[body.tool];
    const idempotencyKey = `studio:${randomUUID()}`;

    // 1. Debit up front — refunded on any downstream failure.
    try {
      await debit({
        accountId: account.accountId,
        amount: PRICING[action],
        type: `spend:${action}`,
        idempotencyKey,
      });
    } catch (err) {
      if (err instanceof InsufficientMannaError) {
        return sendError(
          reply,
          402,
          'insufficient_manna',
          `${body.tool} costs ${PRICING[action]} manna; you have ${err.available}`,
        );
      }
      throw err;
    }

    const refundQuietly = async (): Promise<void> => {
      try {
        await refund({ originalIdempotencyKey: idempotencyKey, type: `refund:${action}` });
      } catch (refundErr) {
        req.log.error(`studio: refund of ${idempotencyKey} failed: ${String(refundErr)}`);
      }
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
      await refundQuietly();
      throw err;
    }

    try {
      await getToolsClient().invokeTool({ tool: body.tool, args: body.args, agentId });
    } catch (err) {
      claim.cancel();
      await refundQuietly();
      if (err instanceof ApiError) throw err;
      const detail =
        err instanceof GatewayHttpError || err instanceof GatewayToolError
          ? err.message
          : 'gateway invocation failed';
      req.log.error(`studio: ${body.tool} invoke failed: ${String(err)}`);
      return sendError(reply, 502, 'gateway_error', `${body.tool} failed: ${detail}`);
    }

    // 3. Wait for the generated file (async: ~10s images, minutes for video).
    let file;
    try {
      file = await claim.promise;
    } catch (err) {
      await refundQuietly();
      if (err instanceof MediaClaimTimeoutError) {
        return sendError(
          reply,
          504,
          'generation_timeout',
          `${body.tool} did not produce a file within ${Math.round(timeoutMs / 1000)}s — manna refunded`,
        );
      }
      throw err;
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
      return { creationId: result.creation.id, url: result.url, mime: result.mime };
    } catch (err) {
      await refundQuietly();
      throw err;
    }
  });
};
