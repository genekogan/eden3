import { createHmac, timingSafeEqual } from 'node:crypto';

import { ApiError } from '../errors';

export const UPLOAD_CAPABILITY_VERSION = 'v1';

export interface UploadCapabilityClaims {
  uploadId: string;
  objectId: string;
  ownerAccountId: string;
  partNumber: number;
  declaredSizeBytes: number;
  declaredMime: string;
  expiresUnix: number;
}
function canonicalInput(claims: UploadCapabilityClaims): string {
  return [
    'eden3-upload-cap-v1',
    claims.uploadId,
    claims.objectId,
    claims.ownerAccountId,
    String(claims.partNumber),
    String(claims.declaredSizeBytes),
    claims.declaredMime,
    String(claims.expiresUnix),
  ].join('\0');
}

function mac(key: Buffer, claims: UploadCapabilityClaims): Buffer {
  return createHmac('sha256', key).update(canonicalInput(claims)).digest();
}

/** Opaque bearer token. The payload is authenticated, not encrypted. */
export function mintUploadCapability(key: Buffer, claims: UploadCapabilityClaims): string {
  if (key.length < 32) throw new Error('Upload capability key must contain at least 32 bytes');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${UPLOAD_CAPABILITY_VERSION}.${payload}.${mac(key, claims).toString('base64url')}`;
}

export function verifyUploadCapability(
  key: Buffer,
  token: string,
  now: Date,
): UploadCapabilityClaims {
  const [version, encoded, encodedMac, extra] = token.split('.');
  if (version !== UPLOAD_CAPABILITY_VERSION || !encoded || !encodedMac || extra !== undefined) {
    throw new ApiError(401, 'invalid_upload_capability', 'Invalid upload capability');
  }

  let claims: UploadCapabilityClaims;
  let suppliedMac: Buffer;
  try {
    const raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    suppliedMac = Buffer.from(encodedMac, 'base64url');
    if (
      typeof raw.uploadId !== 'string' ||
      typeof raw.objectId !== 'string' ||
      typeof raw.ownerAccountId !== 'string' ||
      !Number.isSafeInteger(raw.partNumber) ||
      !Number.isSafeInteger(raw.declaredSizeBytes) ||
      typeof raw.declaredMime !== 'string' ||
      !Number.isSafeInteger(raw.expiresUnix)
    ) {
      throw new Error('malformed claims');
    }
    claims = raw as unknown as UploadCapabilityClaims;
  } catch {
    throw new ApiError(401, 'invalid_upload_capability', 'Invalid upload capability');
  }

  const expected = mac(key, claims);
  if (suppliedMac.length !== expected.length || !timingSafeEqual(suppliedMac, expected)) {
    throw new ApiError(401, 'invalid_upload_capability', 'Invalid upload capability');
  }
  if (claims.expiresUnix <= Math.floor(now.getTime() / 1000)) {
    throw new ApiError(401, 'expired_upload_capability', 'Upload capability expired');
  }
  return claims;
}
