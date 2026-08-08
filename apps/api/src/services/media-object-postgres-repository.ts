import { pg } from '@eden3/db';

import type { MediaObjectRecord, MediaObjectRepository } from './media-object-repository';

interface Row {
  id: string;
  owner_account_id: string;
  display_name: string;
  state: MediaObjectRecord['state'];
  backing_store: MediaObjectRecord['backingStore'];
  backing_key: string;
  legacy_source_url: string | null;
  verified_mime: string | null;
  verified_size_bytes: string | number | null;
  verified_sha256: string | null;
  public_reference_owner_account_id: string | null;
}

function nullableSize(raw: string | number | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid verified media size');
  return value;
}

/** Safe projection only; backing locators never leave the resolver layer. */
export class PostgresMediaObjectRepository implements MediaObjectRepository {
  async findById(objectId: string): Promise<MediaObjectRecord | null> {
    const durableUrl = `/media/${objectId}`;
    const rows = await pg<Row[]>`
      select o.id, o.owner_account_id, o.display_name, o.state, o.backing_store,
             o.backing_key, o.legacy_source_url, o.verified_mime,
             o.verified_size_bytes, o.verified_sha256,
             (
               select c.user_id from creations c
               where c.public = true and c.deleted = false
                 and c.user_id = o.owner_account_id
                 and (
                   c.attributes->>'nsfw_score' is null
                   or (c.attributes->>'nsfw_score') !~ '^[0-9]+(\.[0-9]+)?$'
                   or (c.attributes->>'nsfw_score')::double precision < 0.85
                 )
                 and (
                   c.url = ${durableUrl}
                   or c.thumbnail_url = ${durableUrl}
                   or (o.legacy_source_url is not null and c.url = o.legacy_source_url)
                   or (o.legacy_source_url is not null and c.thumbnail_url = o.legacy_source_url)
                 )
               limit 1
             ) as public_reference_owner_account_id
      from storage_objects o
      where o.id = ${objectId}
      limit 1
    `;
    const row = rows[0];
    return row ? {
      id: row.id,
      ownerAccountId: row.owner_account_id,
      displayName: row.display_name,
      state: row.state,
      backingStore: row.backing_store,
      backingKey: row.backing_key,
      legacySourceUrl: row.legacy_source_url,
      verifiedMime: row.verified_mime,
      verifiedSizeBytes: nullableSize(row.verified_size_bytes),
      verifiedSha256: row.verified_sha256,
      publicReferenceOwnerAccountId: row.public_reference_owner_account_id,
    } : null;
  }
}
