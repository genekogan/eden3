import { pg } from '@eden3/db';

import type {
  CreateUploadRecord,
  StorageObjectState,
  StoredPartAuthorization,
  StoredPolicyEvent,
  StoredUpload,
  StoredUploadPart,
  UploadPurpose,
  UploadRepository,
  UploadSessionState,
} from './upload-repository';

interface UploadRow {
  id: string;
  object_id: string;
  owner_account_id: string;
  purpose: UploadPurpose;
  display_name: string;
  declared_size_bytes: string | number;
  declared_mime: string;
  declared_sha256: string;
  part_size_bytes: string | number;
  backend_upload_id: string;
  backing_key: string;
  backing_store: 'local' | 'r2';
  expires_at: Date | string;
  capability_expires_at: Date | string;
  upload_state: UploadSessionState;
  object_state: StorageObjectState;
  verified_size_bytes: string | number | null;
  verified_mime: string | null;
  verified_sha256: string | null;
  quarantine_reason: string | null;
}

function toSafeNumber(raw: string | number, field: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${field} in upload row`);
  return value;
}

/** Narrow SQL adapter; no route is allowed to issue upload-state SQL directly. */
export class PostgresUploadRepository implements UploadRepository {
  async create(input: CreateUploadRecord): Promise<StoredUpload> {
    await pg.begin(async (tx) => {
      await tx`
        insert into storage_objects
          (id, owner_account_id, purpose, display_name, declared_size_bytes, declared_mime,
           declared_sha256, state, backing_store, backing_key)
        values
          (${input.objectId}, ${input.ownerAccountId}, ${input.purpose}, ${input.displayName},
           ${input.declaredSizeBytes}, ${input.declaredMime}, ${input.declaredSha256},
           'pending', ${input.backingStore}, ${input.backingKey})
      `;
      await tx`
        insert into storage_uploads
          (id, object_id, owner_account_id, backend_multipart_id, part_size_bytes, state,
           expires_at, capability_expires_at)
        values
          (${input.id}, ${input.objectId}, ${input.ownerAccountId}, ${input.backendUploadId},
           ${input.partSizeBytes}, 'initiated', ${input.expiresAt.toISOString()},
           ${input.capabilityExpiresAt.toISOString()})
      `;
    });
    const created = await this.findOwned(input.id, input.ownerAccountId);
    if (!created) throw new Error('Created upload was not readable');
    return created;
  }

  async findOwned(uploadId: string, ownerAccountId: string): Promise<StoredUpload | null> {
    return this.load(uploadId, ownerAccountId);
  }

  async findById(uploadId: string): Promise<StoredUpload | null> {
    return this.load(uploadId);
  }

  private async load(uploadId: string, ownerAccountId?: string): Promise<StoredUpload | null> {
    const rows = await pg<UploadRow[]>`
      select u.id, u.object_id, o.owner_account_id, o.purpose, o.display_name,
             o.declared_size_bytes, o.declared_mime, o.declared_sha256,
             u.part_size_bytes, u.backend_multipart_id as backend_upload_id, o.backing_key,
             o.backing_store,
             u.expires_at, u.capability_expires_at,
             u.state as upload_state, o.state as object_state,
             o.verified_size_bytes, o.verified_mime, o.verified_sha256,
             o.quarantine_reason
      from storage_uploads u
      join storage_objects o on o.id = u.object_id
      where u.id = ${uploadId}
        and (${ownerAccountId ?? null}::uuid is null or o.owner_account_id = ${ownerAccountId ?? null})
      limit 1
    `;
    const row = rows[0];
    if (!row) return null;
    const parts = await pg<Array<{ part_number: number; etag: string; checksum_sha256: string; size_bytes: string | number }>>`
      select part_number, backend_etag as etag, checksum_sha256, size_bytes
      from storage_upload_parts where upload_id = ${uploadId} order by part_number
    `;
    return {
      id: row.id,
      objectId: row.object_id,
      ownerAccountId: row.owner_account_id,
      purpose: row.purpose,
      displayName: row.display_name,
      declaredSizeBytes: toSafeNumber(row.declared_size_bytes, 'declared_size_bytes'),
      declaredMime: row.declared_mime,
      declaredSha256: row.declared_sha256,
      partSizeBytes: toSafeNumber(row.part_size_bytes, 'part_size_bytes'),
      backendUploadId: row.backend_upload_id,
      backingKey: row.backing_key,
      backingStore: row.backing_store,
      expiresAt: new Date(row.expires_at),
      capabilityExpiresAt: new Date(row.capability_expires_at),
      state: row.upload_state,
      objectState: row.object_state,
      verifiedSizeBytes: row.verified_size_bytes === null ? null : toSafeNumber(row.verified_size_bytes, 'verified_size_bytes'),
      verifiedMime: row.verified_mime,
      verifiedSha256: row.verified_sha256,
      quarantineReason: row.quarantine_reason,
      parts: parts.map((part) => ({
        partNumber: part.part_number,
        etag: part.etag,
        checksumSha256: part.checksum_sha256,
        sizeBytes: toSafeNumber(part.size_bytes, 'part_size'),
      })),
    };
  }

  async addPart(uploadId: string, ownerAccountId: string, part: StoredUploadPart): Promise<boolean> {
    return pg.begin(async (tx) => {
      const rows = await tx<{ part_number: number }[]>`
        insert into storage_upload_parts (upload_id, part_number, backend_etag, checksum_sha256, size_bytes)
        select u.id, ${part.partNumber}, ${part.etag}, ${part.checksumSha256}, ${part.sizeBytes}
        from storage_uploads u join storage_objects o on o.id = u.object_id
        where u.id = ${uploadId} and o.owner_account_id = ${ownerAccountId}
          and u.state in ('initiated', 'uploading')
        on conflict (upload_id, part_number) do nothing returning part_number
      `;
      if (rows.length === 1) {
        await tx`update storage_uploads set state = 'uploading', updated_at = now() where id = ${uploadId} and state = 'initiated'`;
      }
      return rows.length === 1;
    });
  }

  async authorizePart(
    uploadId: string,
    ownerAccountId: string,
    authorization: StoredPartAuthorization,
  ): Promise<boolean> {
    const rows = await pg<{ part_number: number }[]>`
      insert into storage_upload_part_authorizations
        (upload_id, part_number, checksum_sha256, size_bytes, expires_at)
      select u.id, ${authorization.partNumber}, ${authorization.checksumSha256},
             ${authorization.sizeBytes}, ${authorization.expiresAt.toISOString()}
      from storage_uploads u
      where u.id = ${uploadId} and u.owner_account_id = ${ownerAccountId}
        and u.state in ('initiated', 'uploading')
        and ${authorization.expiresAt.toISOString()} <= u.capability_expires_at
        and ${authorization.expiresAt.toISOString()} <= u.expires_at
      on conflict (upload_id, part_number) do update
        set expires_at = greatest(storage_upload_part_authorizations.expires_at, excluded.expires_at),
            updated_at = now()
      where storage_upload_part_authorizations.checksum_sha256 = excluded.checksum_sha256
        and storage_upload_part_authorizations.size_bytes = excluded.size_bytes
      returning part_number
    `;
    return rows.length === 1;
  }

  async findPartAuthorization(
    uploadId: string,
    ownerAccountId: string,
    partNumber: number,
  ): Promise<StoredPartAuthorization | null> {
    const rows = await pg<Array<{
      part_number: number;
      checksum_sha256: string;
      size_bytes: string | number;
      expires_at: Date | string;
    }>>`
      select a.part_number, a.checksum_sha256, a.size_bytes, a.expires_at
      from storage_upload_part_authorizations a
      join storage_uploads u on u.id = a.upload_id
      where a.upload_id = ${uploadId} and u.owner_account_id = ${ownerAccountId}
        and a.part_number = ${partNumber}
      limit 1
    `;
    const row = rows[0];
    return row ? {
      partNumber: row.part_number,
      checksumSha256: row.checksum_sha256,
      sizeBytes: toSafeNumber(row.size_bytes, 'authorization_size_bytes'),
      expiresAt: new Date(row.expires_at),
    } : null;
  }

  async markAssemblyCompleted(uploadId: string, ownerAccountId: string): Promise<boolean> {
    return pg.begin(async (tx) => {
      const rows = await tx<{ object_id: string }[]>`
        update storage_uploads u set state = 'completed', completed_at = now(), updated_at = now()
        from storage_objects o
        where u.id = ${uploadId} and u.object_id = o.id and o.owner_account_id = ${ownerAccountId}
          and u.state in ('initiated', 'uploading') returning u.object_id
      `;
      if (!rows[0]) return false;
      await tx`update storage_objects set state = 'uploaded', updated_at = now() where id = ${rows[0].object_id} and state = 'pending'`;
      return true;
    });
  }

  async markAvailable(
    uploadId: string,
    ownerAccountId: string,
    verified: { sizeBytes: number; mime: string; sha256: string },
  ): Promise<StoredUpload | null> {
    await pg.begin(async (tx) => {
      const rows = await tx<{ object_id: string }[]>`
        select u.object_id from storage_uploads u join storage_objects o on o.id = u.object_id
        where u.id = ${uploadId} and o.owner_account_id = ${ownerAccountId}
          and u.state = 'completed' and o.state = 'uploaded' for update
      `;
      if (!rows[0]) return;
      await tx`
        update storage_objects set state = 'verified', verified_size_bytes = ${verified.sizeBytes},
          verified_mime = ${verified.mime}, verified_sha256 = ${verified.sha256}, updated_at = now()
        where id = ${rows[0].object_id} and state = 'uploaded'
      `;
      await tx`update storage_objects set state = 'available', available_at = now(), updated_at = now() where id = ${rows[0].object_id} and state = 'verified'`;
    });
    return this.findOwned(uploadId, ownerAccountId);
  }

  async quarantine(uploadId: string, ownerAccountId: string, reason: string): Promise<StoredPolicyEvent | null> {
    return pg.begin(async (tx) => {
      const objects = await tx<Array<{ object_id: string; object_state: StorageObjectState; quarantine_reason: string | null }>>`
        select o.id as object_id, o.state as object_state, o.quarantine_reason
        from storage_uploads u join storage_objects o on o.id = u.object_id
        where u.id = ${uploadId} and o.owner_account_id = ${ownerAccountId}
          and u.state = 'completed'
        for update
      `;
      const object = objects[0];
      if (!object || object.object_state === 'available') return null;
      const policyCode = object.object_state === 'quarantined'
        ? (object.quarantine_reason ?? reason)
        : reason;
      if (object.object_state !== 'quarantined') {
        await tx`
          update storage_objects set state = 'quarantined', quarantine_reason = ${policyCode}, updated_at = now()
          where id = ${object.object_id} and state <> 'available'
        `;
      }
      await tx`
        insert into storage_policy_events
          (object_id, owner_account_id, event_type, policy_code, state, next_attempt_at)
        values
          (${object.object_id}, ${ownerAccountId}, 'quarantine_required', ${policyCode}, 'pending', now())
        on conflict (object_id, event_type, policy_code) do nothing
      `;
      const events = await tx<Array<{
        id: string;
        object_id: string;
        owner_account_id: string;
        policy_code: string;
        state: StoredPolicyEvent['state'];
        attempt_count: number;
        claim_token: string | null;
      }>>`
        select id, object_id, owner_account_id, policy_code, state, attempt_count, claim_token
        from storage_policy_events
        where object_id = ${object.object_id} and event_type = 'quarantine_required'
          and policy_code = ${policyCode}
        limit 1
      `;
      const event = events[0];
      return event ? {
        id: event.id,
        objectId: event.object_id,
        ownerAccountId: event.owner_account_id,
        policyCode: event.policy_code,
        state: event.state,
        attemptCount: event.attempt_count,
        claimToken: event.claim_token,
      } : null;
    });
  }

  async abort(uploadId: string, ownerAccountId: string): Promise<boolean> {
    return this.stop(uploadId, ownerAccountId, 'aborted');
  }

  async expire(uploadId: string, ownerAccountId: string): Promise<boolean> {
    return this.stop(uploadId, ownerAccountId, 'expired');
  }

  private async stop(uploadId: string, ownerAccountId: string, state: 'aborted' | 'expired'): Promise<boolean> {
    return pg.begin(async (tx) => {
      const rows = await tx<{ object_id: string }[]>`
        update storage_uploads u set state = ${state}, updated_at = now()
        from storage_objects o
        where u.id = ${uploadId} and u.object_id = o.id and o.owner_account_id = ${ownerAccountId}
          and u.state in ('initiated', 'uploading') returning u.object_id
      `;
      if (!rows[0]) return false;
      await tx`update storage_objects set state = 'failed', updated_at = now() where id = ${rows[0].object_id} and state = 'pending'`;
      return true;
    });
  }
}
