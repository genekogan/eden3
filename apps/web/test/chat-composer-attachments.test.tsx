import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { attachmentError, Composer } from '../components/chat/composer';

function file(name: string, type: string, size: number): File {
  return { name, type, size } as File;
}

describe('chat composer attachments', () => {
  it('renders a multiple guarded file picker and drag/drop surface', () => {
    const html = renderToStaticMarkup(<Composer onSend={() => {}} />);
    expect(html).toContain('aria-label="Attach files"');
    expect(html).toContain('multiple=""');
    expect(html).toContain('image/png,image/jpeg,image/gif,image/webp,text/plain,application/json');
    expect(html).toContain('Add up to 8 images or text files');
  });

  it('applies image/text type and byte limits before upload', () => {
    expect(attachmentError(file('photo.png', 'image/png', 10 * 1024 * 1024))).toBeNull();
    expect(attachmentError(file('photo.png', 'image/png', 10 * 1024 * 1024 + 1))).toMatch(/10 MiB/);
    expect(attachmentError(file('notes.txt', 'text/plain', 1024 * 1024))).toBeNull();
    expect(attachmentError(file('notes.txt', 'text/plain', 1024 * 1024 + 1))).toMatch(/1 MiB/);
    expect(attachmentError(file('movie.mp4', 'video/mp4', 100))).toMatch(/PNG/);
    expect(attachmentError(file('empty.json', 'application/json', 0))).toMatch(/Empty/);
  });
});
