import { z } from 'zod';

export const ALLOWED_AVATAR_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
export const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
/** base64 inflates ~4/3; 12MB leaves room for the JSON envelope around 8MB. */
export const AVATAR_UPLOAD_BODY_LIMIT_BYTES = 12 * 1024 * 1024;

export const avatarBodySchema = z.object({
  filename: z.string().trim().min(1).max(300).optional(),
  mime: z.string().trim().min(1).max(200),
  /** Raw base64 (a data: URL prefix is tolerated and stripped). */
  dataBase64: z.string().min(1),
});

/** Decode base64 (tolerating a `data:` URL prefix); null on empty/invalid. */
export function decodeAvatarData(dataBase64: string): Buffer | null {
  const raw =
    dataBase64.includes(',') && dataBase64.trimStart().startsWith('data:')
      ? dataBase64.slice(dataBase64.indexOf(',') + 1)
      : dataBase64;
  try {
    const buffer = Buffer.from(raw, 'base64');
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}
