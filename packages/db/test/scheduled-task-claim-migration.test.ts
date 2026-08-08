import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MIGRATION = fileURLToPath(
  new URL('../migrations/0026_smart_prima.sql', import.meta.url),
);
const SNAPSHOT = fileURLToPath(
  new URL('../migrations/meta/0026_snapshot.json', import.meta.url),
);
const JOURNAL = fileURLToPath(
  new URL('../migrations/meta/_journal.json', import.meta.url),
);

describe('scheduled-task claim-generation migration', () => {
  it('adds only the nullable generation fence and its orphan-shape constraint', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    expect(sql).toContain('ADD COLUMN "pending_occurrence_claim_id" uuid');
    expect(sql).toContain('"triggers_pending_occurrence_claim_shape_check"');
    expect(sql).toContain(
      '"pending_occurrence_id" is not null or "triggers"."pending_occurrence_claim_id" is null',
    );
    expect(sql).not.toMatch(/^\s*(?:truncate|delete|update|drop)\b/im);
  });

  it('keeps snapshot and journal aligned at 0026', async () => {
    const snapshot = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as {
      tables: Record<
        string,
        {
          columns: Record<string, unknown>;
          checkConstraints: Record<string, unknown>;
        }
      >;
    };
    const journal = JSON.parse(await readFile(JOURNAL, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(snapshot.tables['public.triggers']?.columns).toMatchObject({
      pending_occurrence_claim_id: expect.any(Object),
    });
    expect(snapshot.tables['public.triggers']?.checkConstraints).toHaveProperty(
      'triggers_pending_occurrence_claim_shape_check',
    );
    // Located by idx (not tail position) — later additive migrations must not
    // invalidate this assertion. Re-anchored by T08-U01 when 0027 landed.
    expect(journal.entries.find((entry) => entry.idx === 26)).toMatchObject({
      idx: 26,
      tag: '0026_smart_prima',
    });
  });
});
