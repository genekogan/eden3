import { randomUUID } from 'node:crypto';

import type { AuthSession } from '@eden3/core';
import { PRICING, debit, refund } from '@eden3/core';
import { accounts, db, messages, sessions, type Session } from '@eden3/db';
import type { ChatTurnParams, GatewayTurnEvent, GatewayUsage } from '@eden3/gateway';
import type { SessionEvent, Usage } from '@eden3/shared';
import { desc, eq, sql } from 'drizzle-orm';

import type { EventsBus } from '../events-bus';
import { HistorySync, PRIMER_HEADER } from './history-sync';
import type { TurnRegistry } from './turn-registry';

/**
 * Chat turn pipeline (POST /sessions/:idOrNew/messages body → SSE stream).
 *
 * Order of operations (per W2 spec):
 *   1. manna debit  — PRICING.chatTurn, idempotencyKey = the turn uuid;
 *      InsufficientMannaError propagates BEFORE the response is hijacked so
 *      the route can answer with a clean 402 envelope.
 *   2. primer       — migrated sessions (external_id set, gateway_primed_at
 *      null) get the last ≤20 messages prepended so the agent can resume an
 *      eden1 conversation it has never seen (the gateway session is empty).
 *   3. persist the user message row (+ session counters).
 *   4. register the turn in the {@link TurnRegistry} (media correlation).
 *   5. stream the gateway turn, re-emitting every event on the per-session
 *      events bus AND onto the POST response body (both carry the same
 *      @eden3/shared SessionEvent frames).
 *   6. persist the assistant message (usage → eden_message_data jsonb),
 *      bump counters, emit turn.completed.
 *   7. on gateway error: refund the debit, emit error + manna.updated.
 *   8. fire-and-forget trailing history-sync (async media / late messages).
 *
 * Client disconnects do NOT cancel the pipeline: the gateway turn cannot be
 * cancelled upstream, so we keep consuming and persist the assistant reply —
 * the user finds it in history on reload. Only the emit sink goes quiet.
 */

/** Structural compat-client dependency (tests stub it). */
export interface CompatClientLike {
  chatTurn(params: ChatTurnParams): AsyncGenerator<GatewayTurnEvent, void, void>;
}

/** Where turn events go besides the events bus: the POST response body. */
export interface TurnSink {
  emit(event: SessionEvent): void;
  end(): void;
}

export interface RunTurnDeps {
  compat: CompatClientLike;
  bus: EventsBus;
  registry: TurnRegistry;
  historySync: HistorySync;
  /** Error sink for non-fatal background failures (default: swallow). */
  onError?: (err: unknown, context: string) => void;
}

export interface TurnAgent {
  /** Agent `accounts.id`. */
  accountId: string;
  username: string;
  /** OpenClaw agent id the gateway routes by. */
  openclawId: string;
}

export interface RunTurnParams {
  /** Resolved session row — `gatewaySessionKey` must already be set. */
  session: Session;
  agent: TurnAgent;
  user: AuthSession;
  /** The user's message exactly as typed (persisted verbatim). */
  content: string;
  /**
   * Called once the turn is funded and persisted — the route hijacks the
   * reply and returns the SSE sink. Everything failing before this point
   * surfaces as a normal JSON error envelope (e.g. 402).
   */
  beginStream: () => TurnSink;
}

export interface TurnOutcome {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string | null;
  /** Set when the turn failed and the debit was refunded. */
  errorCode: string | null;
}

// ---------------------------------------------------------------------------
// Primer (continue-old-conversation)
// ---------------------------------------------------------------------------

export const PRIMER_MAX_MESSAGES = 20;
export const PRIMER_CONTENT_CHARS = 300;

export interface PrimerMessage {
  senderUsername: string | null;
  role: string | null;
  content: string;
}

/** One transcript line: `[<sender username or role>]: <content trimmed 300ch>`. */
function primerLine(message: PrimerMessage): string {
  const speaker = message.senderUsername ?? message.role ?? 'unknown';
  const collapsed = message.content.replace(/\s+/g, ' ').trim();
  const trimmed =
    collapsed.length > PRIMER_CONTENT_CHARS ? `${collapsed.slice(0, PRIMER_CONTENT_CHARS)}…` : collapsed;
  return `[${speaker}]: ${trimmed}`;
}

/**
 * Render the primer block prepended to the first message of a resumed
 * (migrated) conversation. `messages` must be in chronological order.
 * Starts with {@link PRIMER_HEADER} — history-sync uses that marker to dedupe
 * the gateway's primed user message against the verbatim row we persist.
 */
export function renderPrimer(primerMessages: PrimerMessage[], username: string): string {
  const lines = [
    PRIMER_HEADER,
    ...primerMessages.map(primerLine),
    `(Older Eden conversation resumed — your distilled memories may cover it; memory/users/${username}.md may describe this user.)`,
  ];
  return lines.join('\n');
}

/** True when this session's FIRST gateway turn must carry the primer. */
export function needsPriming(session: Pick<Session, 'externalId' | 'gatewayPrimedAt'>): boolean {
  return session.externalId !== null && session.gatewayPrimedAt === null;
}

/** Load the last ≤20 non-empty messages of a session, chronological. */
export async function loadPrimerMessages(sessionId: string): Promise<PrimerMessage[]> {
  const rows = await db
    .select({
      content: messages.content,
      role: messages.role,
      senderUsername: accounts.username,
    })
    .from(messages)
    .leftJoin(accounts, eq(accounts.id, messages.senderId))
    .where(eq(messages.sessionId, sessionId))
    .orderBy(desc(messages.createdAt))
    .limit(PRIMER_MAX_MESSAGES);
  return rows
    .filter((row) => row.content !== null && row.content.trim() !== '')
    .map((row) => ({
      senderUsername: row.senderUsername,
      role: row.role,
      content: row.content!,
    }))
    .reverse();
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** Shared Usage view of a gateway usage block (cachedTokens stays internal). */
function toSharedUsage(usage: GatewayUsage | undefined): Usage | undefined {
  if (!usage) return undefined;
  const out: Usage = {};
  if (usage.promptTokens !== undefined) out.promptTokens = usage.promptTokens;
  if (usage.completionTokens !== undefined) out.completionTokens = usage.completionTokens;
  if (usage.totalTokens !== undefined) out.totalTokens = usage.totalTokens;
  return out;
}

/** Insert a message row and bump the session counters in one transaction. */
async function persistMessage(row: {
  sessionId: string;
  senderId: string | null;
  role: string;
  content: string;
  name?: string | null;
  edenMessageData?: unknown;
}): Promise<{ id: string; createdAt: Date }> {
  return await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(messages)
      .values({
        sessionId: row.sessionId,
        senderId: row.senderId,
        role: row.role,
        content: row.content,
        name: row.name ?? null,
        edenMessageData: row.edenMessageData ?? null,
      })
      .returning({ id: messages.id, createdAt: messages.createdAt });
    if (!inserted) throw new Error('message insert returned no row');
    await tx
      .update(sessions)
      .set({
        messageCount: sql`${sessions.messageCount} + 1`,
        lastMessageAt: inserted.createdAt,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, row.sessionId));
    return inserted;
  });
}

/**
 * Run one chat turn end to end. Throws only BEFORE `beginStream()` is called
 * (insufficient manna, database failures) — afterwards every failure is
 * reported as an SSE `error` event and the debit is refunded.
 */
export async function runTurn(deps: RunTurnDeps, params: RunTurnParams): Promise<TurnOutcome> {
  const { session, agent, user, content } = params;
  const onError = deps.onError ?? (() => {});
  const sessionKey = session.gatewaySessionKey;
  if (!sessionKey) throw new Error(`session ${session.id} has no gateway session key`);

  const turnId = randomUUID();

  // 1. Debit — idempotencyKey is the turn uuid; a 402 must precede streaming.
  const debited = await debit({
    accountId: user.accountId,
    amount: PRICING.chatTurn,
    type: 'spend:chat',
    idempotencyKey: turnId,
  });

  // A bare refund for the PRE-STREAM window (no SSE sink exists yet, so we
  // cannot publish manna.updated). Any throw between the debit and
  // beginStream() would otherwise orphan the debit — refund it, then re-throw
  // so the route still answers with a JSON error envelope (contract: runTurn
  // throws only before the reply is hijacked).
  const refundBeforeStream = async (err: unknown): Promise<never> => {
    try {
      await refund({ originalIdempotencyKey: turnId, type: 'refund:chat' });
    } catch (refundErr) {
      onError(refundErr, 'manna refund (pre-stream)');
    }
    throw err;
  };

  // Everything between the debit and the first SSE frame runs inside this
  // guarded block: a throw here refunds the debit before propagating, so no
  // path after a successful debit can orphan manna.
  const prepared = await (async (): Promise<{
    sink: TurnSink;
    gatewayMessage: string;
    prime: boolean;
    userMessage: { id: string; createdAt: Date };
  }> => {
    try {
      // 2. Primer (before inserting the new user message, so it is not included).
      const prime = needsPriming(session);
      let gatewayMessage = content;
      if (prime) {
        const primerMessages = await loadPrimerMessages(session.id);
        gatewayMessage = `${renderPrimer(primerMessages, user.username)}\n\n${content}`;
      }

      // 3. Persist the user message VERBATIM (the primer exists only gateway-
      //    side; history-sync backfills the gateway id via the PRIMER_HEADER
      //    suffix rule).
      const userMessage = await persistMessage({
        sessionId: session.id,
        senderId: user.accountId,
        role: 'user',
        content,
      });

      // 4. Media/trailing-sync correlation window.
      deps.registry.register(sessionKey, {
        sessionId: session.id,
        agentAccountId: agent.accountId,
        agentOpenclawId: agent.openclawId,
      });

      // 5. From here on the response is a live SSE stream.
      const sink = params.beginStream();
      return { sink, gatewayMessage, prime, userMessage };
    } catch (err) {
      return refundBeforeStream(err);
    }
  })();
  const { sink, gatewayMessage, prime, userMessage } = prepared;
  const outcome: TurnOutcome = {
    turnId,
    userMessageId: userMessage.id,
    assistantMessageId: null,
    errorCode: null,
  };

  const publish = (event: SessionEvent): void => {
    try {
      deps.bus.publish(session.id, event);
    } catch (err) {
      onError(err, 'events-bus publish');
    }
    try {
      sink.emit(event);
    } catch (err) {
      onError(err, 'sse sink emit'); // client went away — keep the turn going
    }
  };

  const refundTurn = async (): Promise<void> => {
    try {
      const refunded = await refund({ originalIdempotencyKey: turnId, type: 'refund:chat' });
      if (refunded) {
        publish({ type: 'manna.updated', accountId: user.accountId, balance: refunded.balance.total });
      }
    } catch (err) {
      onError(err, 'manna refund');
    }
  };

  try {
    publish({ type: 'turn.started', sessionId: session.id, turnId });
    publish({ type: 'manna.updated', accountId: user.accountId, balance: debited.balance.total });

    let primedMarked = !prime;
    let completed = false;

    for await (const event of deps.compat.chatTurn({
      agentId: agent.openclawId,
      sessionKey,
      userMessage: gatewayMessage,
    })) {
      switch (event.type) {
        case 'turn.started': {
          // The gateway accepted the turn — the primer (if any) is now part of
          // the server-side session history, so mark the session primed.
          if (!primedMarked) {
            primedMarked = true;
            try {
              await db
                .update(sessions)
                .set({ gatewayPrimedAt: new Date(), updatedAt: new Date() })
                .where(eq(sessions.id, session.id));
            } catch (err) {
              onError(err, 'mark gateway_primed_at');
            }
          }
          break;
        }
        case 'token': {
          publish({ type: 'token', turnId, delta: event.delta });
          break;
        }
        case 'turn.completed': {
          completed = true;
          const assistant = await persistMessage({
            sessionId: session.id,
            senderId: agent.accountId,
            role: 'assistant',
            content: event.text,
            name: agent.username,
            edenMessageData: {
              kind: 'chat_turn',
              turnId,
              usage: event.usage ?? null,
              emptyTurn: event.emptyTurn,
              finishReason: event.finishReason ?? null,
            },
          });
          outcome.assistantMessageId = assistant.id;
          if (event.emptyTurn) {
            // Agent said nothing — typically an async media tool is running
            // (spike: compat filler suppressed upstream). Signal the UI.
            publish({ type: 'media.pending', sessionId: session.id, tool: 'unknown' });
          }
          const sharedUsage = toSharedUsage(event.usage);
          publish({
            type: 'turn.completed',
            turnId,
            messageId: assistant.id,
            ...(sharedUsage ? { usage: sharedUsage } : {}),
          });
          break;
        }
        case 'error': {
          outcome.errorCode = event.code;
          await refundTurn();
          publish({ type: 'error', turnId, code: event.code, message: event.message });
          break;
        }
      }
    }

    if (!completed && outcome.errorCode === null) {
      // Stream ended without a terminal event (should not happen) — refund.
      outcome.errorCode = 'gateway_stream_error';
      await refundTurn();
      publish({
        type: 'error',
        turnId,
        code: 'gateway_stream_error',
        message: 'gateway stream ended without completing the turn',
      });
    }
  } catch (err) {
    outcome.errorCode = 'internal_error';
    onError(err, 'turn pipeline');
    await refundTurn();
    publish({
      type: 'error',
      turnId,
      code: 'internal_error',
      message: err instanceof Error ? err.message : 'turn pipeline failed',
    });
  } finally {
    try {
      sink.end();
    } catch (err) {
      onError(err, 'sse sink end');
    }
  }

  // 8. Trailing sync — async media completions & anything else that posts
  //    into the gateway session after the HTTP turn ended.
  if (outcome.errorCode === null) {
    deps.registry.touch(sessionKey);
    deps.historySync.scheduleTrailingSync({
      session,
      agentOpenclawId: agent.openclawId,
      agentAccountId: agent.accountId,
    });
  }

  return outcome;
}
