import path from 'node:path';

import { z } from 'zod';

/**
 * Typed environment loader for eden3.
 *
 * This module reads `process.env` only — it never loads `.env` files itself.
 * Entrypoints are responsible for populating the environment first (e.g. via
 * `loadRootEnv()` from `@eden3/db`, `node --env-file`, or dotenv).
 */

const portSchema = z.coerce.number().int().min(1).max(65535);

export const envSchema = z.object({
  /** Postgres (docker, localhost:5433). */
  DATABASE_URL: z.string().min(1).default('postgres://eden3:eden3@localhost:5433/eden3'),
  /** Local fork of prod Mongo (docker, localhost:27018). */
  MONGO_URL: z.string().min(1).default('mongodb://127.0.0.1:27018/eden-prod'),
  /** OpenClaw gateway (single-tenant trusted backend). */
  OPENCLAW_BASE_URL: z.string().min(1).default('http://127.0.0.1:18789'),
  /** Gateway bearer token — no sane default; undefined until configured. */
  OPENCLAW_GATEWAY_TOKEN: z.string().min(1).optional(),
  /** Directory new media files are written into (content-addressed). */
  MEDIA_DIR: z
    .string()
    .min(1)
    .default(() => path.resolve('var', 'media')),
  /** Public base URL media files are served from. */
  MEDIA_BASE_URL: z.string().min(1).default('http://localhost:4301/media'),
  API_PORT: portSchema.default(4301),
  WEB_PORT: portSchema.default(4300),
});

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(readonly issues: z.ZodIssue[]) {
    const detail = issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    super(`Invalid environment: ${detail}`);
    this.name = 'EnvError';
  }
}

/**
 * Parse an environment object (defaults to `process.env`) into a typed `Env`.
 * Empty-string values are treated as unset so `FOO=` in a shell or .env file
 * falls back to the default. Throws {@link EnvError} on invalid values.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) throw new EnvError(parsed.error.issues);
  return parsed.data;
}

let cached: Env | null = null;

/** Lazily-parsed, cached view of `process.env`. */
export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Drop the {@link getEnv} cache (tests, or after mutating `process.env`). */
export function resetEnvCache(): void {
  cached = null;
}
