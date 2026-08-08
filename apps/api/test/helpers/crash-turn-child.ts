/**
 * T08-U03 crash harness child (checkpoint-#1 finding 2). Runs the REAL turn
 * pipeline to the point where the worst-case reservation + authorization row
 * are durably committed and the provider has been handed the turn, then HANGS.
 * The parent SIGKILLs it — so no catch/reversal ever runs and a genuine
 * `reserved` orphan is left behind for the reaper to compensate. A thrown hook
 * would be caught and reversed in-process; only a real process death produces
 * the crash state.
 *
 * Contract: reads ids from the environment, prints `RESERVED <turnId>` to
 * stdout once the provider stub is entered (the reservation is already
 * committed by then — reserve precedes the provider handoff in turns.ts), then
 * blocks forever.
 */
import type { AuthSession } from '@eden3/core';
import { db, sessions } from '@eden3/db';
import type { GatewayTurnEvent } from '@eden3/gateway';
import { eq } from 'drizzle-orm';

import { EventsBus } from '../../src/events-bus';
import { HistorySync } from '../../src/services/history-sync';
import { TurnRegistry } from '../../src/services/turn-registry';
import { runTurn, type CompatClientLike } from '../../src/services/turns';

async function main(): Promise<void> {
  const turnId = process.env.CRASH_TURN_ID!;
  const userAccountId = process.env.CRASH_USER_ID!;
  const userUsername = process.env.CRASH_USER_USERNAME!;
  const agentAccountId = process.env.CRASH_AGENT_ID!;
  const agentUsername = process.env.CRASH_AGENT_USERNAME!;
  const agentOpenclawId = process.env.CRASH_AGENT_OPENCLAW!;
  const sessionId = process.env.CRASH_SESSION_ID!;
  const model = process.env.CRASH_MODEL ?? 'anthropic/claude-haiku-4-5';

  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session) throw new Error('crash-child: session not found');

  const user: AuthSession = { accountId: userAccountId, username: userUsername, isAdmin: false };

  const compat: CompatClientLike = {
    async *chatTurn(): AsyncGenerator<GatewayTurnEvent, void, void> {
      // The reservation + authorization row are already committed here.
      yield { type: 'turn.started' };
      // Stream a usable token BEFORE hanging, so the SIGKILL leaves a `reserved`
      // orphan whose client already SAW output — proving the predeclared rule
      // (an unpersisted turn is a failed turn and refunds in full, even after a
      // streamed byte; partial-output settlement is DEBT-004, not decided).
      yield { type: 'token', delta: 'partial output before the crash' };
      process.stdout.write(`RESERVED ${turnId}\n`);
      // Hang forever — the parent will SIGKILL us mid-turn.
      await new Promise<void>(() => {});
    },
  };

  await runTurn(
    {
      compat,
      bus: new EventsBus(),
      registry: new TurnRegistry(),
      historySync: new HistorySync({
        tools: {
          sessionsHistory: async () => ({ sessionKey: '', messages: [], truncated: false, contentTruncated: false }),
        },
      }),
    },
    {
      session,
      agent: {
        accountId: agentAccountId,
        username: agentUsername,
        openclawId: agentOpenclawId,
        model,
        gatewayModelOverride: model,
        agentRuntime: 'openclaw',
      },
      user,
      content: 'crash me',
      turnId,
      beginStream: () => ({ emit() {}, end() {} }),
    },
  );
}

main().catch((err) => {
  process.stderr.write(`crash-child error: ${String(err)}\n`);
  process.exit(1);
});
