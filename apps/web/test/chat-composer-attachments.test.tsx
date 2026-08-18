import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import {
  attachmentError,
  clearComposerDraftAfterTurnAcceptance,
  Composer,
  hasComposerRetryPayload,
  resolveComposerDraftIdentity,
  retryComposerDraftAfterTurnAcceptance,
  retryInlineErrorAfterTurnAcceptance,
  shouldApplyComposerHydration,
} from '../components/chat/composer';
import {
  clearDictationComposerDraft,
  DICTATION_CUSTODY_EPOCH_STORAGE_COORDINATE,
  loadDictationComposerDraft,
  persistDictationComposerDraft,
  type DictationPurgeFenceStore,
} from '../lib/dictation-storage';

function file(name: string, type: string, size: number): File {
  return { name, type, size } as File;
}

describe('chat composer attachments', () => {
  it('renders a multiple guarded file picker and drag/drop surface', () => {
    const html = renderToStaticMarkup(<Composer draftKey="test" onSend={() => true} />);
    expect(html).toContain('aria-label="Attach files"');
    expect(html).toContain('multiple=""');
    expect(html).toContain('image/png,image/jpeg,image/gif,image/webp,text/plain,application/json');
    expect(html).toContain('Add up to 8 images or text files');
    expect(html).toContain('Dictation up to 10 minutes');
  });

  it('applies image/text type and byte limits before upload', () => {
    expect(attachmentError(file('photo.png', 'image/png', 10 * 1024 * 1024))).toBeNull();
    expect(attachmentError(file('photo.png', 'image/png', 10 * 1024 * 1024 + 1))).toMatch(/10 MiB/);
    expect(attachmentError(file('notes.txt', 'text/plain', 1024 * 1024))).toBeNull();
    expect(attachmentError(file('notes.txt', 'text/plain', 1024 * 1024 + 1))).toMatch(/1 MiB/);
    expect(attachmentError(file('movie.mp4', 'video/mp4', 100))).toMatch(/PNG/);
    expect(attachmentError(file('empty.json', 'application/json', 0))).toMatch(/Empty/);
  });

  it('keeps Retry reachable for attachment-only messages', () => {
    const attachment = {
      objectId: 'object-review-1',
      attachment: { url: '/objects/object-review-1', mime: 'image/png' },
    };
    expect(hasComposerRetryPayload('', [attachment])).toBe(true);
    expect(hasComposerRetryPayload(null, [attachment])).toBe(true);
    expect(hasComposerRetryPayload('', [])).toBe(true);
    expect(hasComposerRetryPayload(null, [])).toBe(false);
  });

  it('retains a recovered transcript across lost send and refresh until turn acknowledgement', async () => {
    const values = new Map<string, string>();
    const storage: DictationPurgeFenceStore = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    const options = { indexedDB: new IDBFactory(), purgeFenceStore: storage };
    await persistDictationComposerDraft('owner', 'session:one', 'ten minute transcript', options);
    const clear = () => clearDictationComposerDraft('owner', 'session:one', options);
    await expect(clearComposerDraftAfterTurnAcceptance(Promise.resolve(false), clear)).resolves.toBe(false);
    await expect(loadDictationComposerDraft('owner', 'session:one', options)).resolves.toBe('ten minute transcript');
    await expect(clearComposerDraftAfterTurnAcceptance(Promise.resolve(true), clear)).resolves.toBe(true);
    await expect(loadDictationComposerDraft('owner', 'session:one', options)).resolves.toBeNull();
  });

  it('keeps failed retries across refresh and clears only the exact accepted retry context', async () => {
    const values = new Map<string, string>();
    const storage: DictationPurgeFenceStore = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    const options = { indexedDB: new IDBFactory(), purgeFenceStore: storage };
    await persistDictationComposerDraft('owner', 'new:rocket', 'new-chat transcript', options);
    await persistDictationComposerDraft('owner', 'session:one', 'session transcript', options);

    await expect(retryComposerDraftAfterTurnAcceptance(
      Promise.resolve(false), 'owner', 'new:rocket', options,
    )).resolves.toBe(false);
    await expect(loadDictationComposerDraft('owner', 'new:rocket', options)).resolves.toBe('new-chat transcript');

    await expect(retryComposerDraftAfterTurnAcceptance(
      Promise.resolve(true), 'owner', 'session:one', options,
    )).resolves.toBe(true);
    await expect(loadDictationComposerDraft('owner', 'session:one', options)).resolves.toBeNull();
    await expect(loadDictationComposerDraft('owner', 'new:rocket', options)).resolves.toBe('new-chat transcript');
  });

  it('dismisses an inline attachment error only after the retry is admitted', async () => {
    let dismissed = 0;
    await expect(retryInlineErrorAfterTurnAcceptance(
      Promise.resolve(false), null, 'session:one', () => { dismissed += 1; },
    )).resolves.toBe(false);
    expect(dismissed).toBe(0);

    await expect(retryInlineErrorAfterTurnAcceptance(
      Promise.resolve(true), null, 'session:one', () => { dismissed += 1; },
    )).resolves.toBe(true);
    expect(dismissed).toBe(1);
  });

  it('never copies a composer draft across sessions or accounts', async () => {
    const values = new Map<string, string>();
    const storage: DictationPurgeFenceStore = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    const options = { indexedDB: new IDBFactory(), purgeFenceStore: storage };
    await persistDictationComposerDraft('owner-a', 'session:a', 'private A', options);
    const a = await resolveComposerDraftIdentity('owner-a', 'session:a', null, options);
    expect(a).toMatchObject({ changed: true, value: 'private A' });

    const blankB = await resolveComposerDraftIdentity('owner-a', 'session:b', a.identity, options);
    expect(blankB).toMatchObject({ changed: true, value: '' });
    await expect(loadDictationComposerDraft('owner-a', 'session:a', options)).resolves.toBe('private A');

    await persistDictationComposerDraft('owner-a', 'session:b', 'saved B', options);
    await expect(resolveComposerDraftIdentity('owner-a', 'session:b', a.identity, options))
      .resolves.toMatchObject({ value: 'saved B' });

    const other = await resolveComposerDraftIdentity('owner-b', 'session:a', a.identity, options);
    expect(other).toMatchObject({ changed: true, value: '' });
    expect(other.value).not.toContain('private A');
  });

  it('cannot let late hydration overwrite a local edit', () => {
    expect(shouldApplyComposerHydration('owner:a', 'owner:a', 0, 0)).toBe(true);
    expect(shouldApplyComposerHydration('owner:a', 'owner:a', 0, 1)).toBe(false);
    expect(shouldApplyComposerHydration('owner:a', 'owner:b', 0, 0)).toBe(false);
  });

  it('cannot let an old accepted send clear a relogged-in epoch', async () => {
    const values = new Map<string, string>([[DICTATION_CUSTODY_EPOCH_STORAGE_COORDINATE, 'epoch-a']]);
    const storage: DictationPurgeFenceStore = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    const options = { indexedDB: new IDBFactory(), purgeFenceStore: storage };
    await persistDictationComposerDraft('owner', 'session:one', 'old epoch', options);
    let accept!: (accepted: boolean) => void;
    const acceptance = new Promise<boolean>((resolve) => { accept = resolve; });
    const clearing = retryComposerDraftAfterTurnAcceptance(
      acceptance, 'owner', 'session:one', options,
    );
    storage.setItem(DICTATION_CUSTODY_EPOCH_STORAGE_COORDINATE, 'epoch-b');
    await persistDictationComposerDraft('owner', 'session:one', 'new epoch', options);
    accept(true);
    await expect(clearing).resolves.toBe(true);
    await expect(loadDictationComposerDraft('owner', 'session:one', options)).resolves.toBe('new epoch');
  });
});
