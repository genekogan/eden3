import { createHash, randomBytes } from 'node:crypto';

import {
  publicSessionShareDto,
  publicSessionSnapshotDto,
  sessionShareCreateInputDto,
  sessionShareSummaryDto,
  type PublicSessionShareDto,
  type SessionShareCreateInputDto,
  type SessionShareCreateResponseDto,
  type SessionShareListResponseDto,
  type SessionShareMode,
  type SessionShareSummaryDto,
} from '@eden3/shared';

export interface CreateSessionShareCommand {
  sessionId: string;
  actorId: string;
  mode: SessionShareMode;
  title: string | null;
  boundaryMessageId: string | null;
  tokenHash: string;
  createdAt: string;
}

export type CreateSessionShareResult =
  | { status: 'created'; share: SessionShareSummaryDto }
  | { status: 'missing' | 'forbidden' | 'invalid_boundary' | 'token_conflict' };

export type SessionShareListResult =
  | { status: 'ok'; items: SessionShareSummaryDto[] }
  | { status: 'missing' | 'forbidden' };

export type RevokeSessionShareResult =
  | { status: 'revoked'; share: SessionShareSummaryDto }
  | { status: 'missing' | 'forbidden' };

/**
 * Storage seam implemented transactionally by Postgres. Implementations must
 * never persist or log the raw token.
 */
export interface SessionShareRepository {
  create(command: CreateSessionShareCommand): Promise<CreateSessionShareResult>;
  list(sessionId: string, actorId: string): Promise<SessionShareListResult>;
  revoke(
    sessionId: string,
    shareId: string,
    actorId: string,
    revokedAt: string,
  ): Promise<RevokeSessionShareResult>;
  resolvePublic(tokenHash: string): Promise<PublicSessionShareDto | null>;
}

export class SessionShareServiceError extends Error {
  constructor(
    readonly code: 'share_not_found' | 'share_forbidden' | 'invalid_boundary',
  ) {
    super(code);
    this.name = 'SessionShareServiceError';
  }
}

export interface SessionShareServiceOptions {
  token?: () => string;
  now?: () => Date;
}

export function hashSessionShareToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function serviceError(status: CreateSessionShareResult['status']): SessionShareServiceError {
  if (status === 'forbidden') return new SessionShareServiceError('share_forbidden');
  if (status === 'invalid_boundary') return new SessionShareServiceError('invalid_boundary');
  return new SessionShareServiceError('share_not_found');
}

export class SessionShareService {
  private readonly token: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly repository: SessionShareRepository,
    options: SessionShareServiceOptions = {},
  ) {
    this.token = options.token ?? (() => randomBytes(32).toString('base64url'));
    this.now = options.now ?? (() => new Date());
  }

  async create(
    sessionId: string,
    actorId: string,
    rawInput: SessionShareCreateInputDto,
  ): Promise<SessionShareCreateResponseDto> {
    const input = sessionShareCreateInputDto.parse(rawInput);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = this.token();
      if (token.length < 32) throw new Error('session share token generator returned a short token');
      const result = await this.repository.create({
        sessionId,
        actorId,
        mode: input.mode,
        title: input.title ?? null,
        boundaryMessageId: input.boundaryMessageId ?? null,
        tokenHash: hashSessionShareToken(token),
        createdAt: this.now().toISOString(),
      });
      if (result.status === 'token_conflict') continue;
      if (result.status !== 'created') throw serviceError(result.status);
      return {
        share: sessionShareSummaryDto.parse(result.share),
        token,
        publicPath: `/share/${token}`,
      };
    }
    throw new Error('could not allocate a unique session share token');
  }

  async list(sessionId: string, actorId: string): Promise<SessionShareListResponseDto> {
    const result = await this.repository.list(sessionId, actorId);
    if (result.status !== 'ok') throw serviceError(result.status);
    return { items: result.items.map((item) => sessionShareSummaryDto.parse(item)) };
  }

  async revoke(
    sessionId: string,
    shareId: string,
    actorId: string,
  ): Promise<SessionShareSummaryDto> {
    const result = await this.repository.revoke(
      sessionId,
      shareId,
      actorId,
      this.now().toISOString(),
    );
    if (result.status !== 'revoked') throw serviceError(result.status);
    return sessionShareSummaryDto.parse(result.share);
  }

  async resolvePublic(token: string): Promise<PublicSessionShareDto | null> {
    if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) return null;
    const result = await this.repository.resolvePublic(hashSessionShareToken(token));
    if (!result) return null;
    return publicSessionShareDto.parse({
      ...result,
      snapshot: publicSessionSnapshotDto.parse(result.snapshot),
    });
  }
}
