import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { normalizeClerkIdentityImageUrl } from '../src/routes/account';
import { decodeAvatarData } from '../src/services/avatar-upload';

describe('human account avatar custody', () => {
  it('accepts only Clerk first-party identity image URLs', () => {
    expect(normalizeClerkIdentityImageUrl('https://img.clerk.com/abc?width=160')).toBe(
      'https://img.clerk.com/abc?width=160',
    );
    for (const value of [
      'http://img.clerk.com/abc',
      'https://img.clerk.com.evil.test/abc',
      'https://user@img.clerk.com/abc',
      'https://img.clerk.com:444/abc',
      'https://img.clerk.com/#fragment',
      'https://example.test/avatar.png',
    ]) {
      expect(normalizeClerkIdentityImageUrl(value), value).toBeNull();
    }
  });

  it('decodes both raw base64 and data URLs', () => {
    expect(decodeAvatarData('aGVsbG8=')?.toString()).toBe('hello');
    expect(decodeAvatarData('data:image/png;base64,aGVsbG8=')?.toString()).toBe('hello');
  });

  it('keeps manual uploads durable and higher priority than identity sync', async () => {
    const source = await readFile(new URL('../src/routes/account.ts', import.meta.url), 'utf8');
    const identity = source.slice(
      source.indexOf("app.patch('/avatar/identity'"),
      source.indexOf("app.post(\n    '/avatar'"),
    );
    const upload = source.slice(
      source.indexOf("app.post(\n    '/avatar'"),
      source.indexOf("app.delete('/avatar'"),
    );
    expect(identity).toContain('current.userImage !== null && currentIdentityUrl === null');
    expect(identity).toContain('update accounts set user_image=${imageUrl}');
    expect(upload.indexOf('from accounts where id=${accountId}')).toBeLessThan(
      upload.indexOf('getStore().put(buffer'),
    );
    expect(upload).toContain("type='user' and deleted=false");
    expect(upload).toContain('insert into agent_avatar_assets');
    expect(upload.indexOf('insert into agent_avatar_assets')).toBeLessThan(
      upload.indexOf('update accounts set user_image=${next.url}'),
    );
  });

  it('journals the human self-owned avatar guard', async () => {
    const migration = await readFile(
      new URL('../../../packages/db/migrations/0045_human_avatar_asset_custody.sql', import.meta.url),
      'utf8',
    );
    const journal = await readFile(
      new URL('../../../packages/db/migrations/meta/_journal.json', import.meta.url),
      'utf8',
    );
    expect(migration).toContain("NEW.owner_account_id=NEW.agent_account_id");
    expect(migration).toContain("a.type='user' AND a.deleted=false");
    expect(migration).toContain('account_erasure_assert_account_writable');
    expect(journal).toContain('0045_human_avatar_asset_custody');
  });
});
