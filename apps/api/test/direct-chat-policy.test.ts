import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('direct chat ambiguity policy', () => {
  it('keeps the durable workspace doctrine aligned for newly provisioned agents', () => {
    const template = readFileSync(
      resolve(import.meta.dirname, '../../../packages/gateway/workspace-templates/AGENTS.md'),
      'utf8',
    );
    expect(template).toContain('Every direct user message gets a visible response.');
    expect(template).toContain('Never infer media generation from unclear');
  });

  it('keeps policy wrappers out of gateway messages and handles silence server-side', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/services/turns.ts'), 'utf8');
    const prepared = source.slice(
      source.indexOf('// 2. Primer'),
      source.indexOf('// 3. Persist the user message'),
    );
    expect(prepared).not.toContain('Eden direct-message policy');
    expect(prepared).not.toContain('renderDirectChatPolicy');
    expect(prepared).not.toContain('publish({ type: \'media.pending\'');
    expect(source).toContain('assistantText = DIRECT_CHAT_EMPTY_REPLY');
    expect(source).toContain('mediaAuthorized = await hasCurrentTurnMediaAuthorization()');
  });
});
