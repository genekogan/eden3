import {
  BOOTSTRAP_FILE_NAMES,
  type BootstrapFileName,
} from '@eden3/shared';

export const SOUL_WORKSPACE_FILE = 'SOUL.md' as const satisfies BootstrapFileName;

export type WorkspaceDoctrineWritePolicy =
  | { kind: 'ordinary-file'; file: null; writable: true }
  | { kind: 'two-way-settings'; file: typeof SOUL_WORKSPACE_FILE; writable: true }
  | { kind: 'managed-generated'; file: BootstrapFileName; writable: false };

/**
 * The workspace API has an exact reverse projection only for SOUL.md.
 * Generated doctrine stays read-only here until an equally exact parser and
 * provenance-preserving save path exists for its owning Settings surface.
 */
export function workspaceDoctrineWritePolicy(filePath: string): WorkspaceDoctrineWritePolicy {
  if (!(BOOTSTRAP_FILE_NAMES as readonly string[]).includes(filePath)) {
    return { kind: 'ordinary-file', file: null, writable: true };
  }
  const file = filePath as BootstrapFileName;
  if (file === SOUL_WORKSPACE_FILE) {
    return { kind: 'two-way-settings', file, writable: true };
  }
  return { kind: 'managed-generated', file, writable: false };
}
