import type { Metadata } from "next";
import { ChannelsClient } from "@/app/channels/channels-client";

export const metadata: Metadata = { title: "Gateway" };

/**
 * /agents/[username]/gateway — the agent's mediation layer to the outside
 * world: Discord/Telegram bot connections, pairing requests, allowlists,
 * and delivery settings, pinned to this agent.
 */
export default async function AgentGatewayPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  const decoded = decodeURIComponent(username);
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 md:px-10">
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
        @{decoded}
      </p>
      <h1 className="mt-3 text-3xl font-light tracking-tight md:text-4xl">Gateway</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        This agent&apos;s bots on Discord and Telegram — connections, pairing
        requests, and delivery settings. Tokens stay encrypted; only the last
        four characters are ever shown.
      </p>
      <div className="mt-4">
        <ChannelsClient fixedAgent={decoded} />
      </div>
    </div>
  );
}
