import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('collection public-list moderation wiring', () => {
  it('applies one exact threshold predicate to detail, list count, and list covers', () => {
    const source = readFileSync(new URL('../src/routes/collections.ts', import.meta.url), 'utf8');
    expect(source.match(/publicCreationModerationSql\(pg\)/g)).toHaveLength(3);
    expect(source).not.toContain("attributes->>'nsfw_score'");
    expect(source).not.toContain('!~');
    expect(source).toMatch(
      /and \(c\.public = true or \$\{isOwner\}\)\s*\$\{isOwner \? pg`` : pg`and \$\{publicCreationModerationSql\(pg\)\}`\}/,
    );
    expect(source).toMatch(
      /and c\.public = true\s*\$\{options\.includeModerated \? pg`` : pg`and \$\{publicCreationModerationSql\(pg\)\}`\}/,
    );
    expect(source).toMatch(
      /where ranked\.rn <= \$\{COVER_LIMIT\}\s*order by ranked\.collection_id, ranked\.rn/,
    );
  });
});
