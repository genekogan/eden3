import { z } from 'zod';

export const VOICE_ASSIGNMENT_MODES = ['off', 'on_demand', 'always'] as const;
export const voiceAssignmentModeSchema = z.enum(VOICE_ASSIGNMENT_MODES);

export const voiceIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?:[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_.-]*:v[1-9][0-9]*|clone:[0-9a-f-]{36})$/);

export const voiceAssignmentDto = z.object({
  voiceId: voiceIdSchema,
  delivery: z.object({
    chat: voiceAssignmentModeSchema,
    discord: z.enum(['off', 'always']),
    telegram: z.enum(['off', 'always']),
  }),
  updatedAt: z.string().datetime(),
});
export type VoiceAssignmentDto = z.infer<typeof voiceAssignmentDto>;

export const voiceCatalogEntryDto = z.object({
  id: voiceIdSchema,
  provider: z.enum(['deepinfra', 'cartesia', 'elevenlabs']),
  model: z.string().min(1).max(200),
  name: z.string().min(1).max(120),
  language: z.string().min(2).max(35),
  kind: z.enum(['roster', 'clone']),
  preview: z.object({ available: z.boolean() }),
  pricing: z.object({
    unit: z.literal('character'),
    usdPerUnit: z.number().nonnegative(),
    tableVersion: z.string().min(1),
  }),
  capabilities: z.object({
    preview: z.boolean(),
    chat: z.boolean(),
    discord: z.boolean(),
    telegram: z.boolean(),
  }),
});
export type VoiceCatalogEntryDto = z.infer<typeof voiceCatalogEntryDto>;

export const VOICE_CLONE_STATUSES = [
  'pending_validation',
  'quarantined',
  'cloning',
  'provider_create_ambiguous',
  'moderation',
  'ready',
  'failed',
  'revoked',
  'provider_delete_pending',
  'provider_delete_failed',
  'deleted',
] as const;
export const voiceCloneStatusSchema = z.enum(VOICE_CLONE_STATUSES);

export const voiceCloneDto = z.object({
  id: z.string().uuid(),
  voiceId: voiceIdSchema,
  name: z.string().min(1).max(120),
  provider: z.literal('cartesia'),
  status: voiceCloneStatusSchema,
  clipManifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  consentVersion: z.string().min(1).max(100),
  quarantineCode: z.string().max(100).nullable(),
  failureCode: z.string().max(100).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  deletedAt: z.string().datetime().nullable(),
});
export type VoiceCloneDto = z.infer<typeof voiceCloneDto>;

export const voiceExecutionDto = z.object({
  id: z.string().uuid(),
  voiceId: voiceIdSchema,
  purpose: z.enum(['preview', 'chat', 'discord', 'telegram']),
  status: z.enum(['pending', 'provider_started', 'transcoding', 'completed', 'refund_pending', 'artifact_cleanup_pending', 'failed']),
  url: z.string().min(1).nullable(),
  mime: z.string().min(1).nullable(),
  durationMs: z.number().int().positive().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  characterCount: z.number().int().positive(),
  manna: z.number().nonnegative(),
  replayed: z.boolean(),
});
export type VoiceExecutionDto = z.infer<typeof voiceExecutionDto>;

export const voiceQuoteDto = z.object({
  quoteId: z.string().uuid(),
  expiresAt: z.string().datetime(),
  transcriptSha256: z.string().regex(/^[0-9a-f]{64}$/),
  operation: z.enum(['preview', 'chat', 'discord', 'telegram']),
  voiceId: voiceIdSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  characterCount: z.number().int().positive(),
  costUsd: z.number().nonnegative(),
  manna: z.number().nonnegative(),
  authorizedMaxManna: z.number().nonnegative(),
  tableVersion: z.string().min(1),
  pricingEffectiveDate: z.string().date(),
  estimated: z.boolean(),
});
export type VoiceQuoteDto = z.infer<typeof voiceQuoteDto>;
