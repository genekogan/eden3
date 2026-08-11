import type { ChatTurnParams, GatewayTurnEvent } from '@eden3/gateway';

/** Cheap, bounded platform model used only for conversation housekeeping. */
export const SESSION_TITLE_MODEL = 'anthropic/claude-haiku-4-5';
export const SESSION_TITLE_MAX_OUTPUT_TOKENS = 32;
export const SESSION_TITLE_TIMEOUT_MS = 5_000;
const SESSION_TITLE_INPUT_CHARS = 1_200;
const SESSION_TITLE_MAX_CHARS = 72;
const SESSION_TITLE_MAX_WORDS = 7;

export interface SessionTitleCompat {
  chatTurn(params: ChatTurnParams): AsyncGenerator<GatewayTurnEvent, void, void>;
}

export interface GenerateSessionTitleInput {
  compat: SessionTitleCompat;
  agentId: string;
  sessionId: string;
  firstMessage: string;
  persistIfCurrent(title: string): Promise<boolean>;
  forbiddenTitles?: readonly string[];
  timeoutMs?: number;
}

/** Isolated prompt: never includes prior chat state and explicitly forbids tool work. */
export function sessionTitlePrompt(firstMessage: string): string {
  const message = firstMessage.replace(/\s+/g, ' ').trim().slice(0, SESSION_TITLE_INPUT_CHARS);
  return [
    'Create a short title for a conversation from the first user message below.',
    'Return only the title: 2-6 plain words, no quotes, no markdown, no final punctuation.',
    'Do not answer the message and do not use tools.',
    '',
    message,
  ].join('\n');
}

/** Normalize untrusted model output into one compact sidebar-safe line. */
export function normalizeSessionTitle(
  value: string,
  forbiddenTitles: readonly string[] = [],
): string | null {
  let title = value
    .replace(/[`*_#]/g, '')
    .replace(/^\s*(?:title\s*:\s*)/i, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[.!?,;:]+$/g, '')
    .trim();
  if (!title) return null;
  title = title.split(' ').slice(0, SESSION_TITLE_MAX_WORDS).join(' ');
  if (title.length > SESSION_TITLE_MAX_CHARS) {
    title = title.slice(0, SESSION_TITLE_MAX_CHARS).trimEnd();
  }
  if (!title) return null;
  const folded = title.toLocaleLowerCase();
  if (forbiddenTitles.some((candidate) => candidate.trim().toLocaleLowerCase() === folded)) {
    return null;
  }
  return title;
}

/**
 * Run a best-effort title turn in an isolated gateway session. Persistence is
 * compare-and-set against the still-null title so a human rename always wins
 * the race.
 */
export async function generateSessionTitle(input: GenerateSessionTitleInput): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(),
    Math.max(1, input.timeoutMs ?? SESSION_TITLE_TIMEOUT_MS),
  );
  timer.unref?.();
  try {
    let completedText = '';
    for await (const event of input.compat.chatTurn({
      agentId: input.agentId,
      sessionKey: `eden3:title:${input.sessionId}`,
      userMessage: sessionTitlePrompt(input.firstMessage),
      modelOverride: SESSION_TITLE_MODEL,
      maxOutputTokens: SESSION_TITLE_MAX_OUTPUT_TOKENS,
      signal: abort.signal,
    })) {
      if (event.type === 'error') return false;
      if (event.type === 'turn.completed' && !event.emptyTurn) completedText = event.text;
    }
    if (abort.signal.aborted) return false;
    const title = normalizeSessionTitle(completedText, input.forbiddenTitles);
    return title ? input.persistIfCurrent(title) : false;
  } finally {
    clearTimeout(timer);
  }
}
