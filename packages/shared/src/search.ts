import { z } from 'zod';

import { isoDateTimeSchema, uuidSchema } from './dto';

export const OWNED_SEARCH_KINDS = [
  'agent',
  'session',
  'creation',
  'collection',
  'task',
] as const;

export const ownedSearchKindSchema = z.enum(OWNED_SEARCH_KINDS);
export type OwnedSearchKind = z.infer<typeof ownedSearchKindSchema>;

export const searchNavigationTargetSchema = z.object({
  type: z.literal('navigate'),
  href: z.string().startsWith('/').transform((href) => href as `/${string}`),
});
export type SearchNavigationTarget = z.infer<typeof searchNavigationTargetSchema>;

export const ownedSearchResultDto = z.object({
  id: uuidSchema,
  kind: ownedSearchKindSchema,
  label: z.string().min(1),
  description: z.string().nullable(),
  updatedAt: isoDateTimeSchema,
  target: searchNavigationTargetSchema,
});
export type OwnedSearchResultDto = z.infer<typeof ownedSearchResultDto>;

export const ownedSearchResponseDto = z.object({
  items: z.array(ownedSearchResultDto),
  query: z.string(),
});
export type OwnedSearchResponseDto = z.infer<typeof ownedSearchResponseDto>;
