import { z } from 'zod';

import { isoDateTimeSchema, uuidSchema } from './dto';

export const SESSION_SHARE_MODES = ['snapshot', 'live'] as const;
export const sessionShareModeSchema = z.enum(SESSION_SHARE_MODES);
export type SessionShareMode = z.infer<typeof sessionShareModeSchema>;

export const sessionShareCreateInputDto = z.object({
  mode: sessionShareModeSchema,
  title: z.string().trim().min(1).max(160).optional(),
  /** Omit to capture through the latest committed message. */
  boundaryMessageId: uuidSchema.optional(),
});
export type SessionShareCreateInputDto = z.infer<typeof sessionShareCreateInputDto>;

const safeMediaUrlSchema = z.string().refine(
  (value) =>
    /^https:\/\//i.test(value) ||
    (/^\//.test(value) && !/^\/\//.test(value)),
  'public attachments require an https or same-origin URL',
);

export const publicSessionAttachmentDto = z.object({
  url: safeMediaUrlSchema,
  mime: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});
export type PublicSessionAttachmentDto = z.infer<typeof publicSessionAttachmentDto>;

export const publicSessionMessageDto = z.object({
  id: uuidSchema,
  role: z.enum(['user', 'assistant', 'system']),
  name: z.string().nullable(),
  content: z.string().nullable(),
  attachments: z.array(publicSessionAttachmentDto),
  createdAt: isoDateTimeSchema,
});
export type PublicSessionMessageDto = z.infer<typeof publicSessionMessageDto>;

export const publicSessionAgentDto = z.object({
  username: z.string().min(1),
  name: z.string().nullable(),
  userImage: safeMediaUrlSchema.nullable(),
});
export type PublicSessionAgentDto = z.infer<typeof publicSessionAgentDto>;

export const publicSessionSnapshotDto = z.object({
  sessionTitle: z.string().nullable(),
  agents: z.array(publicSessionAgentDto),
  messages: z.array(publicSessionMessageDto),
  boundaryMessageId: uuidSchema.nullable(),
  capturedAt: isoDateTimeSchema,
});
export type PublicSessionSnapshotDto = z.infer<typeof publicSessionSnapshotDto>;

export const sessionShareSummaryDto = z.object({
  id: uuidSchema,
  sessionId: uuidSchema,
  mode: sessionShareModeSchema,
  title: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  revokedAt: isoDateTimeSchema.nullable(),
});
export type SessionShareSummaryDto = z.infer<typeof sessionShareSummaryDto>;

export const sessionShareCreateResponseDto = z.object({
  share: sessionShareSummaryDto,
  /** Returned once. Only the hash is persisted by the API. */
  token: z.string().min(32),
  publicPath: z.string().startsWith('/share/'),
});
export type SessionShareCreateResponseDto = z.infer<typeof sessionShareCreateResponseDto>;

export const sessionShareListResponseDto = z.object({
  items: z.array(sessionShareSummaryDto),
});
export type SessionShareListResponseDto = z.infer<typeof sessionShareListResponseDto>;

export const publicSessionShareDto = z.object({
  share: sessionShareSummaryDto.pick({ id: true, mode: true, title: true, createdAt: true }),
  snapshot: publicSessionSnapshotDto,
});
export type PublicSessionShareDto = z.infer<typeof publicSessionShareDto>;
