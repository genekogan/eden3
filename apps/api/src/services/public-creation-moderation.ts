export const PUBLIC_CREATION_NSFW_THRESHOLD = 0.85;

/**
 * Public surfaces fail closed when a score is present but is not a canonical
 * JSON number. This keeps application checks and PostgreSQL authorization in
 * parity instead of treating unfamiliar string spellings as safe.
 */
export function passesPublicCreationModeration(attributes: unknown): boolean {
  if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) {
    return true;
  }
  if (!Object.prototype.hasOwnProperty.call(attributes, 'nsfw_score')) return true;
  const score = (attributes as Record<string, unknown>).nsfw_score;
  return (
    typeof score === 'number' &&
    Number.isFinite(score) &&
    score < PUBLIC_CREATION_NSFW_THRESHOLD
  );
}

/**
 * Constant, non-user-controlled SQL for queries whose creations alias is `c`.
 * `unsafe` is used only to insert these frozen bytes as a reusable fragment.
 */
export const PUBLIC_CREATION_MODERATION_SQL = `(
  c.attributes is null
  or not (c.attributes ? 'nsfw_score')
  or (
    jsonb_typeof(c.attributes->'nsfw_score') = 'number'
    and (c.attributes->>'nsfw_score')::numeric < 0.85
  )
)`;

interface SqlFragmentFactory<T> {
  unsafe(query: string): T;
}

export function publicCreationModerationSql<T>(sql: SqlFragmentFactory<T>): T {
  return sql.unsafe(PUBLIC_CREATION_MODERATION_SQL);
}
