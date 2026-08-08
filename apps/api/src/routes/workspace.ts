import { resolveAgentByUsername } from '@eden3/core';
import { pg, type Account, type Agent } from '@eden3/db';
import { readWorkspaceDoctrineFiles } from '@eden3/gateway';
import { lintPersonaDoctrine } from '@eden3/shared';
import { ZipArchive } from 'archiver';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import path from 'node:path';
import { z } from 'zod';

import { ApiError, errorEnvelope } from '../errors';
import {
  WORKSPACE_TEXT_MAX_BYTES,
  listWorkspaceTree,
  openWorkspaceDownload,
  readWorkspaceFile,
  resolveWorkspacePath,
  sha256Hex,
  workspaceDownloadMime,
  writeWorkspaceFile,
} from '../services/workspace-files';
import {
  AGENT_RUNTIME_SYNC_LOCK_SEED,
  agentRuntimeSyncLockKey,
} from '../services/agent-runtime-sync';
import {
  SOUL_WORKSPACE_FILE,
  workspaceDoctrineWritePolicy,
} from '../services/workspace-doctrine-policy';
import { canManage } from './agents';

/**
 * Agent workspace browser (owner/admin only) — registered under /agents.
 *
 *   GET /agents/:username/workspace           — recursive tree (hidden/internal
 *                                               names filtered, capped at 2,000
 *                                               entries -> truncated:true)
 *   GET /agents/:username/workspace/file      — ?path= text content (≤512KB
 *                                               valid UTF-8) or binary metadata
 *   GET /agents/:username/workspace/download  — ?path= raw bytes (≤100MB)
 *   GET /agents/:username/workspace/export    — whole workspace as a zip
 *                                               stream (SPEC Q11 export-as-files)
 *   PUT /agents/:username/workspace/file      — {path, content, baseSha256}
 *                                               conflict-checked atomic save
 *
 * Access mirrors the memory routes: 401 anonymous, 404 for non-owners of a
 * private agent (existence hidden), 403 for non-owners of a public one, and
 * 409 before provisioning. Path-jail details live in services/workspace-files.
 */

const usernameParamsSchema = z.object({ username: z.string().trim().min(1).max(200) });

const filePathQuerySchema = z.object({ path: z.string().min(1).max(1024) });

const saveBodySchema = z.object({
  path: z.string().min(1).max(1024),
  content: z.string(),
  // 'new' = "I am creating this file"; anything else must match the current
  // bytes on disk or the save is rejected (never silently clobber the agent).
  baseSha256: z.string().regex(/^(new|[0-9a-f]{64})$/, 'baseSha256 must be "new" or a sha256 hex'),
  // Required for the two-way SOUL.md surface. Ordinary workspace files keep
  // their existing SHA-only contract.
  baseRevision: z.number().int().nonnegative().optional(),
});

interface DoctrineRevisionRow {
  persona: string | null;
  runtime_sync_version: number;
}

async function readDoctrineRevision(accountId: string): Promise<DoctrineRevisionRow> {
  const rows = await pg<DoctrineRevisionRow[]>`
    select persona, runtime_sync_version
    from agents
    where account_id = ${accountId}
  `;
  const row = rows[0];
  if (!row) throw new ApiError(404, 'agent_not_found', 'Agent no longer exists');
  return row;
}

function doctrineFileMetadata(
  file: Awaited<ReturnType<typeof readWorkspaceFile>>,
  row: DoctrineRevisionRow,
) {
  if (file.kind !== 'text' || file.path !== SOUL_WORKSPACE_FILE) return file;
  return {
    ...file,
    doctrineRevision: row.runtime_sync_version,
    doctrineSyncState:
      file.sha256 === sha256Hex(row.persona ?? '') ? ('synced' as const) : ('conflict' as const),
  };
}

/**
 * SOUL.md IS the agent's persona (single source of truth). Editing it in the
 * workspace browser must write the same bytes back into `agents.persona` so the
 * DB never diverges from the file — otherwise the next profile edit re-renders
 * SOUL.md from a stale DB persona and silently clobbers the hand-edit. The
 * gateway template renders SOUL.md verbatim from `{{PERSONA}}`, so this is an
 * exact round-trip (see packages/gateway/workspace-templates/SOUL.md).
 */
async function resolveManagedWorkspace(
  req: FastifyRequest,
  username: string,
): Promise<{ account: Account; agent: Agent; root: string }> {
  const resolved = await resolveAgentByUsername(username);
  if (!resolved) throw new ApiError(404, 'agent_not_found', `No agent named "${username}"`);
  const { account, agent } = resolved;
  if (!canManage(req.account, account, agent)) {
    if (!agent.public) throw new ApiError(404, 'agent_not_found', `No agent named "${username}"`);
    throw new ApiError(403, 'forbidden', 'Only the owner can browse this agent workspace');
  }
  if (!agent.openclawId || !agent.workspacePath) {
    throw new ApiError(409, 'workspace_unavailable', 'Agent workspace is available after provisioning');
  }
  return { account, agent, root: agent.workspacePath };
}

function attachmentFilename(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}

export const workspaceRoutes: FastifyPluginAsync = async (app) => {
  // ---- GET /agents/:username/workspace — recursive tree --------------------
  app.get('/:username/workspace', { preHandler: app.requireAuth }, async (req) => {
    const { username } = usernameParamsSchema.parse(req.params);
    const { root } = await resolveManagedWorkspace(req, username);
    const { entries, truncated } = await listWorkspaceTree(root);
    return { entries, truncated };
  });

  // ---- GET /agents/:username/workspace/file — text content or binary meta --
  app.get('/:username/workspace/file', { preHandler: app.requireAuth }, async (req) => {
    const { username } = usernameParamsSchema.parse(req.params);
    const { path: filePath } = filePathQuerySchema.parse(req.query);
    const { account, root } = await resolveManagedWorkspace(req, username);
    const file = await readWorkspaceFile(root, filePath);
    if (file.kind !== 'text' || file.path !== SOUL_WORKSPACE_FILE) return { file };

    // The revision is DB-authoritative and the hash is file-authoritative. A
    // runtime/file write that crosses this read may conservatively surface a
    // conflict; it can never be mislabeled as synced unless the exact bytes
    // equal the persisted persona.
    return { file: doctrineFileMetadata(file, await readDoctrineRevision(account.id)) };
  });

  // ---- GET /agents/:username/workspace/download — raw bytes ----------------
  app.get('/:username/workspace/download', { preHandler: app.requireAuth }, async (req, reply) => {
    const { username } = usernameParamsSchema.parse(req.params);
    const { path: filePath } = filePathQuerySchema.parse(req.query);
    const { root } = await resolveManagedWorkspace(req, username);
    const download = await openWorkspaceDownload(root, filePath);
    const basename = path.posix.basename(download.rel);
    return reply
      .header('content-type', workspaceDownloadMime(basename))
      .header('content-length', download.sizeBytes)
      .header('content-disposition', `attachment; filename="${attachmentFilename(basename)}"`)
      .send(download.stream);
  });

  // ---- GET /agents/:username/workspace/export — whole workspace as zip -----
  app.get('/:username/workspace/export', { preHandler: app.requireAuth }, async (req, reply) => {
    const { username } = usernameParamsSchema.parse(req.params);
    const { account, root } = await resolveManagedWorkspace(req, username);
    // Same hidden-name filtering as the tree; hashing skipped (zip only needs
    // the bytes) and a higher cap so big workspaces still export whole.
    const { entries } = await listWorkspaceTree(root, { withHashes: false, maxEntries: 10_000 });

    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on('error', (err) => {
      req.log.error({ err }, `workspace export failed for "${account.username}"`);
      archive.destroy();
    });
    for (const entry of entries) {
      if (entry.kind === 'dir') continue;
      // entry.path came from the jailed tree walk (symlinks skipped), so it is
      // safe to join back onto the root.
      archive.file(path.join(root, entry.path), { name: entry.path });
    }
    void archive.finalize();
    return reply
      .header('content-type', 'application/zip')
      .header(
        'content-disposition',
        `attachment; filename="${attachmentFilename(`${account.username}-workspace.zip`)}"`,
      )
      .send(archive);
  });

  // ---- PUT /agents/:username/workspace/file — conflict-checked save --------
  app.put('/:username/workspace/file', { preHandler: app.requireAuth }, async (req, reply) => {
    const { username } = usernameParamsSchema.parse(req.params);
    const body = saveBodySchema.parse(req.body);
    if (Buffer.byteLength(body.content, 'utf8') > WORKSPACE_TEXT_MAX_BYTES) {
      throw new ApiError(
        413,
        'workspace_file_too_large',
        `Content exceeds the ${WORKSPACE_TEXT_MAX_BYTES / 1024}KB text limit`,
      );
    }
    const { account, root } = await resolveManagedWorkspace(req, username);
    // Canonicalize/reject aliases before ownership policy. Policy must never
    // classify one spelling while the filesystem writer resolves another.
    const canonicalPath = resolveWorkspacePath(root, body.path, { forWrite: true }).rel;
    const doctrinePolicy = workspaceDoctrineWritePolicy(canonicalPath);
    if (!doctrinePolicy.writable) {
      throw new ApiError(
        409,
        'workspace_file_managed',
        `${doctrinePolicy.file} is generated by Eden or a Settings surface and is read-only in Workspace`,
      );
    }
    if (doctrinePolicy.kind === 'two-way-settings') {
      const prospective = await readWorkspaceDoctrineFiles(root);
      prospective[doctrinePolicy.file] = body.content;
      const issues = lintPersonaDoctrine(prospective);
      if (issues.length > 0) {
        throw new ApiError(
          422,
          'persona_doctrine_violation',
          `The edit would violate the agent persona contract: ${issues
            .map((issue) => issue.message)
            .join('; ')}`,
        );
      }
    }
    if (doctrinePolicy.kind === 'two-way-settings' && body.baseRevision === undefined) {
      throw new ApiError(
        400,
        'workspace_revision_required',
        'SOUL.md saves require the revision that was loaded',
      );
    }

    if (doctrinePolicy.kind === 'two-way-settings') {
      const outcome = await pg.begin(async (tx) => {
        // The runtime projector owns this exact cross-process session-lock
        // identity. Taking its transaction-scoped form first ensures no stale
        // renderer can resume after this filesystem write and clobber it.
        await tx`select pg_advisory_xact_lock(hashtextextended(${agentRuntimeSyncLockKey(account.id)}::text, ${AGENT_RUNTIME_SYNC_LOCK_SEED}))`;
        // Match PATCH /agents/:username's desired-row lock namespace after the
        // external-mutation fence. Settings releases seed 91 before it enters
        // runtime synchronization, so this order cannot cycle with PATCH.
        await tx`select pg_advisory_xact_lock(hashtextextended(${account.id}::text, 91))`;
        const rows = await tx<DoctrineRevisionRow[]>`
          select persona, runtime_sync_version
          from agents
          where account_id = ${account.id}
          for update
        `;
        const current = rows[0];
        if (!current) throw new ApiError(404, 'agent_not_found', 'Agent no longer exists');

        if (current.runtime_sync_version !== body.baseRevision) {
          const file = await readWorkspaceFile(root, canonicalPath);
          return {
            ok: false as const,
            currentSha256: file.kind === 'text' ? file.sha256 : null,
            currentMtime: file.mtime,
            currentRevision: current.runtime_sync_version,
          };
        }

        const result = await writeWorkspaceFile({
          root,
          path: canonicalPath,
          content: body.content,
          baseSha256: body.baseSha256,
        });
        if (!result.ok) {
          return {
            ...result,
            currentRevision: current.runtime_sync_version,
          };
        }

        const persona = body.content === '' ? null : body.content;
        const updated = await tx<{ runtime_sync_version: number }[]>`
          update agents
          set persona = ${persona},
              runtime_sync_version = runtime_sync_version + 1,
              runtime_sync_error = null
          where account_id = ${account.id}
          returning runtime_sync_version
        `;
        const revision = updated[0]?.runtime_sync_version;
        if (revision === undefined) {
          throw new ApiError(404, 'agent_not_found', 'Agent no longer exists');
        }
        return {
          ok: true as const,
          file: {
            ...result.file,
            doctrineRevision: revision,
            doctrineSyncState: 'synced' as const,
          },
        };
      });

      if (!outcome.ok) {
        return reply.code(409).send({
          ...errorEnvelope(
            409,
            'workspace_write_conflict',
            'SOUL.md changed in Workspace or Settings — choose a version before saving',
          ),
          currentSha256: outcome.currentSha256,
          currentMtime: outcome.currentMtime,
          currentRevision: outcome.currentRevision,
        });
      }
      return { file: outcome.file };
    }

    const result = await writeWorkspaceFile({
      root,
      path: canonicalPath,
      content: body.content,
      baseSha256: body.baseSha256,
    });
    if (!result.ok) {
      // The agent (or another tab) changed the file since the caller loaded
      // it. Return what is on disk now so the UI can offer a reload.
      return reply.code(409).send({
        ...errorEnvelope(
          409,
          'workspace_write_conflict',
          'The file changed since it was loaded — reload before saving',
        ),
        currentSha256: result.currentSha256,
        currentMtime: result.currentMtime,
      });
    }

    return { file: result.file };
  });
};
