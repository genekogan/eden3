import type { ObjectBackingStore, ObjectLifecycleState, StoredObject } from '@eden3/core';

import { ApiError } from '../errors';

export interface MediaObjectRecord {
  id: string;
  ownerAccountId: string;
  displayName: string;
  state: ObjectLifecycleState;
  backingStore: ObjectBackingStore;
  backingKey: string;
  legacySourceUrl: string | null;
  verifiedMime: string | null;
  verifiedSizeBytes: number | null;
  verifiedSha256: string | null;
  /** Owner id of an eligible public creation reference, otherwise null. */
  publicReferenceOwnerAccountId: string | null;
  /** True only when the supplied active share token references this object. */
  shareReferenceActive: boolean;
}

export interface MediaObjectRepository {
  findById(objectId: string, shareTokenHash?: string | null): Promise<MediaObjectRecord | null>;
}

export interface MediaObjectHydrator {
  hydrate(
    object: StoredObject,
    destination?: { displayName?: string },
  ): Promise<{
    localPath: string;
    release(): Promise<void>;
  }>;
}

export interface ResolvedMediaObject {
  objectId: string;
  displayName: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  publiclyReferenced: boolean;
  storedObject: StoredObject;
}

function notFound(): ApiError {
  return new ApiError(404, 'media_object_not_found', 'Media object not found');
}

const SAFE_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** Defense-in-depth lifecycle and audience check ahead of hydration/streaming. */
export class MediaObjectResolver {
  constructor(
    private readonly repository: MediaObjectRepository,
    readonly hydrator: MediaObjectHydrator,
  ) {}

  async resolve(
    objectId: string,
    viewerAccountId: string | null,
    shareTokenHash: string | null = null,
  ): Promise<ResolvedMediaObject> {
    const row = await this.repository.findById(objectId, shareTokenHash);
    if (
      !row ||
      row.state !== 'available' ||
      row.verifiedMime === null ||
      row.verifiedSizeBytes === null ||
      row.verifiedSha256 === null ||
      !SAFE_MIME.test(row.verifiedMime) ||
      !Number.isSafeInteger(row.verifiedSizeBytes) ||
      row.verifiedSizeBytes < 0 ||
      !SHA256.test(row.verifiedSha256)
    ) {
      throw notFound();
    }
    const publiclyReferenced = row.publicReferenceOwnerAccountId === row.ownerAccountId;
    if (
      viewerAccountId !== row.ownerAccountId &&
      !publiclyReferenced &&
      !row.shareReferenceActive
    ) throw notFound();
    return {
      objectId: row.id,
      displayName: row.displayName,
      mime: row.verifiedMime,
      sizeBytes: row.verifiedSizeBytes,
      sha256: row.verifiedSha256,
      publiclyReferenced,
      storedObject: {
        objectId: row.id,
        backingKey: row.backingKey,
        backingStore: row.backingStore,
        state: row.state,
        sha256: row.verifiedSha256,
        sizeBytes: row.verifiedSizeBytes,
        mime: row.verifiedMime,
        legacySourceUrl: row.legacySourceUrl,
      },
    };
  }
}
