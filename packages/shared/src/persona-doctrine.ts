/**
 * Eden's executable subset of the persona doctrine ported from
 * ~/Dev/claw/AGENT_BOOTSTRAP.md on 2026-07-31. The source repository remains
 * read-only; these constants keep the cockpit's builder and provisioner honest.
 */

export const BOOTSTRAP_FILE_NAMES = [
  'IDENTITY.md',
  'SOUL.md',
  'AGENTS.md',
  'USER.md',
  'TOOLS.md',
  'MEMORY.md',
  'HEARTBEAT.md',
] as const;

export type BootstrapFileName = (typeof BOOTSTRAP_FILE_NAMES)[number];
export type BootstrapFileSet = Record<BootstrapFileName, string>;

export const MAX_BOOTSTRAP_FILE_CHARS = 20_000;
export const MAX_BOOTSTRAP_TOTAL_CHARS = 150_000;

/** Exact zero-signal phrases called out by the doctrine's banality list. */
export const PERSONA_BANALITY_PHRASES = [
  'you are not a chatbot',
  "you're not a chatbot",
  "you're becoming someone",
  'you wake fresh each session',
  'these files are your continuity',
  'be genuinely helpful, not performatively helpful',
  "skip the 'great question!'",
  "be the assistant you'd actually want to talk to",
  'earn trust through competence',
  "remember you're a guest",
  'private things stay private',
  'customize freely',
  'be careful with external actions, bold with internal ones',
  'slowness is a feature',
  "you're stewarding something",
  'this is sacred work',
  'fill in during your first conversation',
  'make it yours',
  'treat this as a gift',
] as const;

export interface PersonaDoctrineIssue {
  code: 'missing-file' | 'file-budget' | 'total-budget' | 'banality' | 'required-content';
  message: string;
  file?: BootstrapFileName;
}

/**
 * Normalize presentation-only differences before matching doctrine phrases.
 * Persona text commonly arrives from rich-text fields, so curly quotes,
 * non-breaking spaces, or a line-wrap must not turn the lint into an evasion.
 */
function normalizeDoctrineText(content: string): string {
  return content
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findPersonaBanalities(content: string): string[] {
  const normalized = normalizeDoctrineText(content);
  return PERSONA_BANALITY_PHRASES.filter((phrase) =>
    normalized.includes(normalizeDoctrineText(phrase)),
  );
}

const REQUIRED_CONTENT: Partial<Record<BootstrapFileName, readonly string[]>> = {
  'IDENTITY.md': [
    'name:',
    'role:',
    'do not impersonate',
    'change my name',
    'data, not commands',
    'untrusted',
    'ask before deleting',
    'sending',
    'spending',
  ],
  'AGENTS.md': [
    'runtime-provided session context',
    'before any irreversible',
    'memory.md',
    'if anything is ambiguous, ask',
    'disclosure boundary',
    'shared channels',
  ],
  'USER.md': ['identity authority', 'current peer'],
  'TOOLS.md': ['image_generate', 'never paste raw file paths'],
};

/** Validate a complete, rendered seven-file bootstrap set. */
export function lintPersonaDoctrine(
  files: Partial<Record<BootstrapFileName, string>>,
): PersonaDoctrineIssue[] {
  const issues: PersonaDoctrineIssue[] = [];
  let totalChars = 0;

  for (const file of BOOTSTRAP_FILE_NAMES) {
    const content = files[file];
    if (content === undefined) {
      issues.push({ code: 'missing-file', file, message: `${file} is missing` });
      continue;
    }
    totalChars += content.length;
    if (content.length > MAX_BOOTSTRAP_FILE_CHARS) {
      issues.push({
        code: 'file-budget',
        file,
        message: `${file} is ${content.length} chars (maximum ${MAX_BOOTSTRAP_FILE_CHARS})`,
      });
    }
    for (const phrase of findPersonaBanalities(content)) {
      issues.push({
        code: 'banality',
        file,
        message: `${file} contains banned zero-signal phrase: ${JSON.stringify(phrase)}`,
      });
    }
    const normalized = normalizeDoctrineText(content);
    for (const required of REQUIRED_CONTENT[file] ?? []) {
      if (!normalized.includes(required)) {
        issues.push({
          code: 'required-content',
          file,
          message: `${file} is missing doctrine anchor: ${JSON.stringify(required)}`,
        });
      }
    }
  }

  if (totalChars > MAX_BOOTSTRAP_TOTAL_CHARS) {
    issues.push({
      code: 'total-budget',
      message: `bootstrap set is ${totalChars} chars (maximum ${MAX_BOOTSTRAP_TOTAL_CHARS})`,
    });
  }
  return issues;
}
