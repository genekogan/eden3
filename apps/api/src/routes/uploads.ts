import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../errors';
import { UploadService } from '../services/upload-service';

export interface UploadRoutesOptions {
  service: UploadService;
}

const purposeSchema = z.enum([
  'chat',
  'training-set',
  'skill-asset',
  'voice-clip',
  'concept-reference',
  'generated',
  'account-export',
]);
const initiateSchema = z.object({
  displayName: z.string().trim().min(1).max(255),
  purpose: purposeSchema,
  declaredSizeBytes: z.number().int().positive(),
  declaredMime: z.string().trim().min(3).max(200),
  declaredSha256: z.string().regex(/^[a-f0-9]{64}$/),
  partSizeBytes: z.number().int().positive().optional(),
});
const uploadParams = z.object({ uploadId: z.string().uuid() });
const partParams = uploadParams.extend({ partNumber: z.coerce.number().int().positive() });
const signBody = z.object({ checksumSha256: z.string().regex(/^[a-f0-9]{64}$/) });
const capabilityHeader = z.string().min(1).max(4_096);

function localPartCapability(value: string | string[] | undefined): string {
  const parsed = capabilityHeader.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(401, 'invalid_upload_capability', 'Invalid upload capability');
  }
  return parsed.data;
}

function canonicalContentLength(value: string | string[] | undefined): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new ApiError(411, 'part_content_length_required', 'A canonical Content-Length is required');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > UploadService.MAX_OBJECT_BYTES) {
    throw new ApiError(413, 'upload_too_large', 'Upload part exceeds the size limit');
  }
  return parsed;
}

/**
 * upload.resumable@v1 route module. Shared registration/configuration belongs
 * to Task 1; this plugin has no ambient secret or backend defaults.
 */
export const uploadsRoutes: FastifyPluginAsync<UploadRoutesOptions> = async (app, options) => {
  if (!options.service) throw new Error('uploadsRoutes requires an UploadService');

  if (options.service.localPartUploadsEnabled && !app.hasContentTypeParser('application/octet-stream')) {
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: UploadService.MAX_OBJECT_BYTES },
      (_request, body, done) => done(null, body),
    );
  }

  app.post('/uploads', { preHandler: app.requireAuth }, async (request, reply) => {
    const input = initiateSchema.parse(request.body);
    // The tenant is intentionally sourced only from authenticated state. Any
    // owner/account field sent in JSON is ignored by the schema above.
    const reservation = await options.service.initiate(request.account!.accountId, input);
    return reply.code(201).send(reservation);
  });

  app.get('/uploads/:uploadId', { preHandler: app.requireAuth }, async (request) => {
    const { uploadId } = uploadParams.parse(request.params);
    return options.service.status(request.account!.accountId, uploadId);
  });

  app.post(
    '/uploads/:uploadId/parts/:partNumber',
    { preHandler: app.requireAuth },
    async (request) => {
      const { uploadId, partNumber } = partParams.parse(request.params);
      return options.service.signPart(
        request.account!.accountId,
        uploadId,
        partNumber,
        signBody.parse(request.body ?? {}),
      );
    },
  );

  if (options.service.localPartUploadsEnabled) {
    app.put(
      '/uploads/:uploadId/parts/:partNumber',
      {
        bodyLimit: UploadService.MAX_OBJECT_BYTES,
        preParsing: async (request, _reply, payload) => {
          const { uploadId, partNumber } = partParams.parse(request.params);
          const token = localPartCapability(request.headers['x-eden-upload-capability']);
          if (request.headers['content-type'] !== 'application/octet-stream') {
            throw new ApiError(415, 'invalid_part_content_type', 'Part body must be application/octet-stream');
          }
          const contentLength = canonicalContentLength(request.headers['content-length']);
          const preflight = await options.service.preflightLocalPart(token, {
            expectedUploadId: uploadId,
            expectedPartNumber: partNumber,
          });
          if (contentLength !== preflight.expectedSizeBytes) {
            throw new ApiError(400, 'part_size_mismatch', 'Part Content-Length does not match authorization');
          }
          return payload;
        },
      },
      async (request, reply) => {
      const { uploadId, partNumber } = partParams.parse(request.params);
      const token = localPartCapability(request.headers['x-eden-upload-capability']);
      if (!Buffer.isBuffer(request.body)) {
        throw new ApiError(415, 'invalid_part_content_type', 'Part body must be application/octet-stream');
      }
      // URL coordinates must agree before a single byte reaches the backend.
      const result = await options.service.putLocalPart(token, request.body, {
        expectedUploadId: uploadId,
        expectedPartNumber: partNumber,
      });
      return reply.code(201).send(result);
      },
    );
  }

  app.post(
    '/uploads/:uploadId/parts/:partNumber/complete',
    { preHandler: app.requireAuth },
    async (request) => {
      const { uploadId, partNumber } = partParams.parse(request.params);
      const { checksumSha256 } = signBody.parse(request.body);
      return options.service.confirmDirectPart(
        request.account!.accountId,
        uploadId,
        partNumber,
        checksumSha256,
      );
    },
  );

  app.post('/uploads/:uploadId/complete', { preHandler: app.requireAuth }, async (request) => {
    const { uploadId } = uploadParams.parse(request.params);
    return options.service.complete(request.account!.accountId, uploadId);
  });

  app.delete('/uploads/:uploadId', { preHandler: app.requireAuth }, async (request) => {
    const { uploadId } = uploadParams.parse(request.params);
    return options.service.abort(request.account!.accountId, uploadId);
  });
};
