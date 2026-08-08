import { BOOTSTRAP_FILE_NAMES } from '@eden3/shared';
import { describe, expect, it } from 'vitest';

import {
  SOUL_WORKSPACE_FILE,
  workspaceDoctrineWritePolicy,
} from '../src/services/workspace-doctrine-policy';

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

  it('leaves ordinary workspace files writable', () => {
    expect(workspaceDoctrineWritePolicy('notes/idea.md')).toEqual({
      kind: 'ordinary-file',
      file: null,
      writable: true,
    });
  });
});
