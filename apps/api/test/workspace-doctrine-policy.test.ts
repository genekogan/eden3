import { BOOTSTRAP_FILE_NAMES } from '@eden3/shared';
import { describe, expect, it } from 'vitest';

import {
  SOUL_WORKSPACE_FILE,
  workspaceDoctrineWritePolicy,
} from '../src/services/workspace-doctrine-policy';
import { resolveWorkspacePath } from '../src/services/workspace-files';

describe('workspace doctrine write ownership', () => {
  it('permits the proven SOUL.md two-way path', () => {
    expect(workspaceDoctrineWritePolicy(SOUL_WORKSPACE_FILE)).toEqual({
      kind: 'two-way-settings',
      file: 'SOUL.md',
      writable: true,
    });
  });

  it.each(BOOTSTRAP_FILE_NAMES.filter((file) => file !== SOUL_WORKSPACE_FILE))(
    'keeps generated %s read-only in the generic workspace API',
    (file) => {
      expect(workspaceDoctrineWritePolicy(file)).toEqual({
        kind: 'managed-generated',
        file,
        writable: false,
      });
    },
  );

  it.each(BOOTSTRAP_FILE_NAMES)(
    'treats noncanonical case for %s as managed instead of an ordinary file',
    (file) => {
      expect(workspaceDoctrineWritePolicy(file.toLowerCase())).toEqual({
        kind: 'managed-generated',
        file,
        writable: false,
      });
    },
  );

  it('leaves ordinary workspace files writable', () => {
    expect(workspaceDoctrineWritePolicy('notes/idea.md')).toEqual({
      kind: 'ordinary-file',
      file: null,
      writable: true,
    });
  });

  it.each(['SOUL.md/', 'SOUL.md//', 'notes//idea.md'])(
    'rejects noncanonical empty-segment path %s instead of normalizing it',
    (file) => {
      expect(() => resolveWorkspacePath('/tmp/agent-workspace', file, { forWrite: true })).toThrow(
        /stay inside the agent workspace/,
      );
    },
  );
});
