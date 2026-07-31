import {
  MAX_BOOTSTRAP_FILE_CHARS,
  findPersonaBanalities,
} from '@eden3/shared';

export interface LegacyDoctrineNormalization {
  changed: boolean;
  content: string;
  reasons: string[];
}

function removeBanalSentences(content: string): string {
  // Keep delimiters attached to each segment so filtering a sentence or line
  // does not concatenate the surrounding words. The original bytes are always
  // archived before this normalized copy is installed.
  return content
    .split(/(?<=[.!?])(?=\s)|(?<=\n)/u)
    .filter((segment) => findPersonaBanalities(segment).length === 0)
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function usefulBoundary(content: string, hardLimit: number): number {
  if (content.length <= hardLimit) return content.length;
  const floor = Math.max(0, hardLimit - 2_000);
  const window = content.slice(floor, hardLimit);
  for (const delimiter of ['\n\n', '\n', '. ', ' ']) {
    const offset = window.lastIndexOf(delimiter);
    if (offset >= 0) return floor + offset + (delimiter === '. ' ? 1 : 0);
  }
  return hardLimit;
}

/**
 * Produce the bounded, injected copy of oversized/banal legacy material.
 * Callers must archive the exact original bytes at `archiveRelPath` before
 * applying a changed result.
 */
export function planLegacyDoctrineNormalization(
  original: string,
  archiveRelPath: string,
): LegacyDoctrineNormalization {
  const banalities = findPersonaBanalities(original);
  const oversized = original.length > MAX_BOOTSTRAP_FILE_CHARS;
  if (!oversized && banalities.length === 0) {
    return { changed: false, content: original, reasons: [] };
  }

  const reasons = [
    ...(oversized ? [`${original.length} chars exceeds ${MAX_BOOTSTRAP_FILE_CHARS}`] : []),
    ...banalities.map((phrase) => `banned phrase ${JSON.stringify(phrase)}`),
  ];
  const archiveNote = [
    '',
    '',
    '## Archived legacy context',
    '',
    `The complete pre-reconciliation text is preserved at \`${archiveRelPath}\`.`,
    'Use memory search when a request depends on details beyond this active context.',
  ].join('\n');
  const sanitized = removeBanalSentences(original);
  const contentBudget = MAX_BOOTSTRAP_FILE_CHARS - archiveNote.length;
  const boundary = usefulBoundary(sanitized, contentBudget);
  const prefix = sanitized.slice(0, boundary).trimEnd();
  const content = `${prefix}${archiveNote}`;

  if (content.length > MAX_BOOTSTRAP_FILE_CHARS) {
    throw new Error(`legacy doctrine normalization exceeded its ${MAX_BOOTSTRAP_FILE_CHARS}-char budget`);
  }
  const remainingBanalities = findPersonaBanalities(content);
  if (remainingBanalities.length > 0) {
    throw new Error(
      `legacy doctrine normalization retained banned phrases: ${remainingBanalities.join(', ')}`,
    );
  }
  return { changed: true, content, reasons };
}
