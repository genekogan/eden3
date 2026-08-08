"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, isEndpointMissing } from "@/lib/api";
import type {
  AgentDto,
  ChannelConnectionCreateInput,
  ChannelConnectionDto,
  ChannelKind,
  ChannelPairingRequestDto,
  TelegramManagedBotOnboardingStatus,
  XByoCredentialsInput,
  XConnectionDto,
} from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { SkeletonRows } from "@/components/skeleton";
import { formatRelativeTime } from "@/lib/format";
import {
  DISCORD_DEVELOPER_PORTAL,
  X_DEVELOPER_PORTAL,
  channelClientDeepLink,
  connectionHealthLabel,
  discordInviteUrl,
  telegramManagedStep,
  trustedTelegramUrl,
  xClientDeepLink,
  xFailureAction,
} from "./connector-ui";

const CHANNELS: Array<{ value: ChannelKind; label: string }> = [
  { value: "discord", label: "Discord" },
  { value: "telegram", label: "Telegram" },
];

const LABELS: Record<ChannelKind, string> = {
  discord: "Discord",
  telegram: "Telegram",
};

/** Owned-agents dropdown cap; connections always load fully regardless. */
const MAX_AGENT_PAGES = 5;

interface ConnectionDraft {
  dmPolicy: "pairing" | "allowlist";
  allowFrom: string;
}

type Phase = "loading" | "ready" | "error";

function errorCopy(error: unknown): string {
  if (isEndpointMissing(error)) return "Connections are not available in this API build.";
  if (error instanceof ApiError) return error.message;
  return "The API is offline. Start @eden3/api and retry.";
}

function statusTone(connection: ChannelConnectionDto): string {
  if (connection.observedState === "live") {
    return "border-emerald-400/25 bg-emerald-400/10 text-emerald-300";
  }
  if (connection.observedState === "error") {
    return "border-rose-400/25 bg-rose-400/10 text-rose-300";
  }
  if (connection.observedState === "starting") {
    return "border-amber-400/25 bg-amber-400/10 text-amber-200";
  }
  return "border-edge bg-white/[0.04] text-muted";
}

function initialDraft(connection: ChannelConnectionDto): ConnectionDraft {
  return {
    dmPolicy: connection.config.dmPolicy,
    allowFrom: connection.config.allowFrom.join(", "),
  };
}

function parseAllowFrom(value: string): string[] | null {
  const ids = [...new Set(value.split(/[\s,]+/).map((id) => id.trim()).filter(Boolean))];
  return ids.every((id) => /^-?\d{3,25}$/.test(id)) ? ids : null;
}

function agentLabel(agent: AgentDto): string {
  return agent.name ? `${agent.name} (@${agent.username})` : `@${agent.username}`;
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-faint">
        {label}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

export function ChannelsClient() {
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [connections, setConnections] = useState<ChannelConnectionDto[]>([]);
  const [xConnections, setXConnections] = useState<XConnectionDto[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [channel, setChannel] = useState<ChannelKind>("discord");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ConnectionDraft>>({});
  const [pairings, setPairings] = useState<Record<string, ChannelPairingRequestDto[]>>({});
  const [pairingLinks, setPairingLinks] = useState<Record<string, boolean>>({});
  const [pairingCodes, setPairingCodes] = useState<Record<string, string>>({});
  const [rotateTokens, setRotateTokens] = useState<Record<string, string>>({});
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [xCredentials, setXCredentials] = useState<XByoCredentialsInput>({
    apiKey: "",
    apiSecret: "",
    accessToken: "",
    accessTokenSecret: "",
  });
  const [xLabel, setXLabel] = useState("");
  const [telegramSuggestedUsername, setTelegramSuggestedUsername] = useState("");
  const [telegramOwnerBindingUrl, setTelegramOwnerBindingUrl] = useState<string | null>(null);
  const [telegramOnboarding, setTelegramOnboarding] =
    useState<TelegramManagedBotOnboardingStatus | null>(null);
  const alive = useRef(true);

  const mergeConnection = useCallback((connection: ChannelConnectionDto) => {
    setConnections((current) =>
      current.some((item) => item.id === connection.id)
        ? current.map((item) => (item.id === connection.id ? connection : item))
        : [connection, ...current],
    );
    setDrafts((current) => ({
      ...current,
      [connection.id]: current[connection.id] ?? initialDraft(connection),
    }));
  }, []);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const [mine, channelList, xList] = await Promise.all([
        (async () => {
          const items: AgentDto[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < MAX_AGENT_PAGES; page += 1) {
            const result = await api.agents.list({ scope: "mine", ...(cursor ? { cursor } : {}) });
            items.push(...result.items);
            if (!result.nextCursor) break;
            cursor = result.nextCursor;
          }
          return items;
        })(),
        api.channels.list(),
        api.channels.listX().catch((error) => {
          if (isEndpointMissing(error)) return { items: [], nextCursor: null };
          throw error;
        }),
      ]);
      if (!alive.current) return;
      setAgents(mine);
      setConnections(channelList.items);
      setXConnections(xList.items);
      setDrafts(Object.fromEntries(channelList.items.map((item) => [item.id, initialDraft(item)])));
      setSelectedAgentId((current) => {
        if (current && mine.some((agent) => agent.id === current)) return current;
        const requested = new URLSearchParams(window.location.search)
          .get("agent")
          ?.replace(/^@/, "")
          .toLowerCase();
        const fromQuery = requested
          ? mine.find((agent) => agent.username.toLowerCase() === requested)
          : undefined;
        const firstConnected = mine.find((agent) =>
          channelList.items.some((item) => item.agentId === agent.id),
        );
        return (fromQuery ?? firstConnected ?? mine[0])?.id ?? null;
      });
      setPhase("ready");
    } catch (error) {
      if (!alive.current) return;
      setNote(errorCopy(error));
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const telegramStep = telegramManagedStep(telegramOnboarding?.intent.state ?? "");

  useEffect(() => {
    const intentId = telegramOnboarding?.intent.id;
    if (!intentId || telegramStep === "attach" || telegramStep === "complete" || telegramStep === "terminal") {
      return;
    }
    let disposed = false;
    let inFlight = false;
    const poll = () => {
      if (inFlight) return;
      inFlight = true;
      void api.channels.managedTelegramStatus(intentId).then(
        (status) => {
          if (disposed || !alive.current) return;
          if (status.connection) {
            mergeConnection(status.connection);
            setTelegramOnboarding(null);
            setTelegramOwnerBindingUrl(null);
            setNote("Telegram bot attached. Configure access below, then activate the connection.");
            return;
          }
          setTelegramOnboarding(status);
        },
        (error) => {
          if (!disposed && alive.current) setNote(errorCopy(error));
        },
      ).finally(() => {
        inFlight = false;
      });
    };
    const timer = window.setInterval(poll, 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [mergeConnection, telegramOnboarding?.intent.id, telegramOnboarding?.intent.state, telegramStep]);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );

  const agentConnections = useMemo(
    () => connections.filter((item) => item.agentId === selectedAgentId),
    [connections, selectedAgentId],
  );

  const agentXConnections = useMemo(
    () => xConnections.filter((item) => item.agentId === selectedAgentId),
    [xConnections, selectedAgentId],
  );

  const unassignedXConnections = useMemo(
    () => xConnections.filter((item) => !agents.some((agent) => agent.id === item.agentId)),
    [xConnections, agents],
  );

  /** Connections whose bound agent is no longer in the owned list (e.g. deleted agent). */
  const unassignedConnections = useMemo(
    () => connections.filter((item) => !agents.some((agent) => agent.id === item.agentId)),
    [connections, agents],
  );

  const connectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of connections) {
      if (!item.agentId) continue;
      counts.set(item.agentId, (counts.get(item.agentId) ?? 0) + 1);
    }
    return counts;
  }, [connections]);

  /** Connected agents first so they aren't buried in large agent rosters. */
  const sortedAgents = useMemo(
    () =>
      [...agents].sort((a, b) => {
        const connected = (connectionCounts.get(b.id) ?? 0) - (connectionCounts.get(a.id) ?? 0);
        if (connected !== 0) return connected;
        return agentLabel(a).localeCompare(agentLabel(b), undefined, { sensitivity: "base" });
      }),
    [agents, connectionCounts],
  );

  const selectAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    setNote(null);
    const agent = agents.find((item) => item.id === agentId);
    if (agent) {
      const url = new URL(window.location.href);
      url.searchParams.set("agent", agent.username);
      window.history.replaceState(null, "", url.toString());
    }
  };

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedAgent) {
      setNote("Pick one of your agents first.");
      return;
    }
    if (channel === "telegram") {
      setBusy("telegram:start");
      setNote(null);
      try {
        const suggestedBotUsername = telegramSuggestedUsername.trim().replace(/^@/, "");
        const started = await api.channels.startManagedTelegram(
          suggestedBotUsername ? { suggestedBotUsername } : {},
        );
        if (!alive.current) return;
        setTelegramOwnerBindingUrl(trustedTelegramUrl(started.ownerBindingUrl));
        setTelegramOnboarding({
          intent: started.intent,
          managedBotUrl: null,
          connection: null,
        });
        setNote("Onboarding started. Open Telegram to confirm that you own this Eden account.");
      } catch (error) {
        if (alive.current) setNote(errorCopy(error));
      } finally {
        if (alive.current) setBusy(null);
      }
      return;
    }
    const cleanToken = token.trim();
    if (!cleanToken) {
      setNote("A bot token is required.");
      return;
    }
    const input: ChannelConnectionCreateInput = {
      channel,
      token: cleanToken,
      agentUsername: selectedAgent.username,
      ...(label.trim() ? { label: label.trim() } : {}),
    };
    setBusy("create");
    setNote(null);
    try {
      const connection = await api.channels.create(input);
      if (!alive.current) return;
      mergeConnection(connection);
      setToken("");
      setLabel("");
      setNote(
        connection.lastError
          ? connection.lastError.message
          : "Token verified. Configure access below, then activate the connection.",
      );
    } catch (error) {
      if (alive.current) setNote(errorCopy(error));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const attachManagedTelegram = async () => {
    if (!selectedAgent || !telegramOnboarding || telegramStep !== "attach") return;
    setBusy("telegram:attach");
    setNote(null);
    try {
      const connection = await api.channels.attachManagedTelegram(
        telegramOnboarding.intent.id,
        {
          agentUsername: selectedAgent.username,
          ...(label.trim() ? { label: label.trim() } : {}),
        },
      );
      if (!alive.current) return;
      mergeConnection(connection);
      setTelegramOnboarding(null);
      setTelegramOwnerBindingUrl(null);
      setTelegramSuggestedUsername("");
      setLabel("");
      setNote("Telegram bot attached. Configure access below, then activate the connection.");
    } catch (error) {
      if (alive.current) setNote(errorCopy(error));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const cancelManagedTelegram = async () => {
    if (!telegramOnboarding) return;
    setBusy("telegram:cancel");
    setNote(null);
    try {
      await api.channels.cancelManagedTelegram(telegramOnboarding.intent.id);
      if (!alive.current) return;
      setTelegramOnboarding(null);
      setTelegramOwnerBindingUrl(null);
      setNote("Telegram onboarding cancelled. No bot was attached.");
    } catch (error) {
      if (alive.current) setNote(errorCopy(error));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const resetManagedTelegram = () => {
    setTelegramOnboarding(null);
    setTelegramOwnerBindingUrl(null);
    setNote("Start a new Telegram onboarding when you’re ready.");
  };

  const connectX = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedAgent) {
      setNote("Pick one of your agents first.");
      return;
    }
    if (Object.values(xCredentials).some((value) => !value.trim())) {
      setNote("Enter all four values from your X developer app.");
      return;
    }
    setBusy("create:x");
    setNote(null);
    try {
      const connection = await api.channels.connectX({
        agentUsername: selectedAgent.username,
        ...(xLabel.trim() ? { label: xLabel.trim() } : {}),
        credentials: xCredentials,
      });
      if (!alive.current) return;
      setXConnections((current) => [connection, ...current.filter((item) => item.id !== connection.id)]);
      setXCredentials({ apiKey: "", apiSecret: "", accessToken: "", accessTokenSecret: "" });
      setXLabel("");
      setNote(`X connected as @${connection.user?.username ?? "your account"}.`);
    } catch (error) {
      if (alive.current) {
        const body = error instanceof ApiError ? error.body : null;
        const code =
          body && typeof body === "object" && "error" in body &&
          body.error && typeof body.error === "object" && "code" in body.error
            ? String(body.error.code)
            : null;
        const action = xFailureAction(code);
        setNote([errorCopy(error), action].filter(Boolean).join(" "));
      }
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const revokeX = async (connection: XConnectionDto) => {
    setBusy(`revoke:x:${connection.id}`);
    setNote(null);
    try {
      await api.channels.revokeX(connection.id);
      if (!alive.current) return;
      setXConnections((current) => current.filter((item) => item.id !== connection.id));
      setNote("Eden access to this X app was revoked. Revoke the token in X too if it may be exposed.");
    } catch (error) {
      if (alive.current) setNote(errorCopy(error));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const retry = async (connection: ChannelConnectionDto) => {
    const replacement = (rotateTokens[connection.id] ?? "").trim();
    setBusy(`retry:${connection.id}`);
    try {
      const result = await api.channels.retry(connection.id, replacement || undefined);
      if (!alive.current) return;
      mergeConnection(result.connection);
      setRotateTokens((current) => ({ ...current, [connection.id]: "" }));
      setNote(result.ok ? "Token verified." : (result.connection.lastError?.message ?? "Validation failed."));
    } catch (error) {
      if (alive.current) setNote(errorCopy(error));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const activate = async (connection: ChannelConnectionDto) => {
    const draft = drafts[connection.id] ?? initialDraft(connection);
    const allowFrom = parseAllowFrom(draft.allowFrom);
    if (!allowFrom) {
      setNote("Allowlist IDs must be numeric Discord/Telegram user IDs.");
      return;
    }
    if (draft.dmPolicy === "allowlist" && allowFrom.length === 0) {
      setNote("Allowlist policy requires at least one user ID.");
      return;
    }
    setBusy(`activate:${connection.id}`);
    try {
      const result = await api.channels.activate(connection.id, {
        dmPolicy: draft.dmPolicy,
        allowFrom,
      });
      if (!alive.current) return;
      mergeConnection(result.connection);
      setNote(`${LABELS[connection.channel]} is starting for ${result.runtime.boundAgent}.`);
    } catch (error) {
      if (alive.current) setNote(errorCopy(error));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const deactivate = async (connection: ChannelConnectionDto) => {
    setBusy(`deactivate:${connection.id}`);
    try {
      const result = await api.channels.deactivate(connection.id);
      if (alive.current) mergeConnection(result.connection);
    } catch (error) {
      if (alive.current) setNote(errorCopy(error));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const loadPairing = async (connection: ChannelConnectionDto) => {
    setBusy(`pairing:${connection.id}`);
    try {
      const result = await api.channels.pairing(connection.id);
      if (alive.current) setPairings((current) => ({ ...current, [connection.id]: result.items }));
    } catch (error) {
      if (alive.current) setNote(errorCopy(error));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const decidePairing = async (
    connection: ChannelConnectionDto,
    request: ChannelPairingRequestDto,
    decision: "approve" | "deny",
  ) => {
    setBusy(`pairing:${request.id}`);
    try {
      const linkToMyAccount = decision === "approve" && (pairingLinks[request.id] ?? false);
      const pairingCode = (pairingCodes[request.id] ?? "").trim();
      await api.channels.decidePairing(
        connection.id,
        request.id,
        decision,
        linkToMyAccount ? { linkToMyAccount, pairingCode } : {},
      );
      setPairingLinks((current) => ({ ...current, [request.id]: false }));
      setPairingCodes((current) => ({ ...current, [request.id]: "" }));
      await loadPairing(connection);
      if (decision === "approve") {
        await load();
        setNote(
          linkToMyAccount
            ? "Sender approved and verified as your Eden account. Web and channel memory now match."
            : "Sender approved for this bot without linking an Eden account.",
        );
      }
    } catch (error) {
      if (alive.current) setNote(errorCopy(error));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const remove = async (connection: ChannelConnectionDto) => {
    if (confirmingId !== connection.id) {
      setConfirmingId(connection.id);
      return;
    }
    setBusy(`delete:${connection.id}`);
    try {
      await api.channels.delete(connection.id);
      if (alive.current) setConnections((items) => items.filter((item) => item.id !== connection.id));
    } catch (error) {
      if (alive.current) setNote(errorCopy(error));
    } finally {
      if (alive.current) {
        setBusy(null);
        setConfirmingId(null);
      }
    }
  };

  const inputClass =
    "w-full rounded-lg border border-edge bg-background px-3 py-2 text-sm text-foreground placeholder:text-faint focus:border-accent/60 focus:outline-none";

  const renderConnection = (connection: ChannelConnectionDto) => {
    const draft = drafts[connection.id] ?? initialDraft(connection);
    const pending = (pairings[connection.id] ?? []).filter((item) => item.status === "pending");
    const clientLink = channelClientDeepLink(connection);
    const inviteLink =
      connection.channel === "discord" && connection.bot?.id
        ? discordInviteUrl(connection.bot.id)
        : null;
    return (
      <li key={connection.id} className="rounded-xl border border-edge bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">{connection.label || connection.bot?.username || LABELS[connection.channel]}</h3>
              <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${statusTone(connection)}`}>
                {connection.observedState}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              {LABELS[connection.channel]} · Credential encrypted
              {connection.bot?.username ? ` · @${connection.bot.username}` : ""}
            </p>
            <p className="mt-1 text-xs text-muted">{connectionHealthLabel(connection)}</p>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-faint">Updated {formatRelativeTime(connection.updatedAt)}</p>
          </div>
          <button type="button" disabled={busy === `delete:${connection.id}`} onClick={() => void remove(connection)} className={`rounded-lg border px-3 py-1.5 text-xs ${confirmingId === connection.id ? "border-rose-400/50 bg-rose-400/10 text-rose-300" : "border-edge text-muted hover:text-rose-300"}`}>
            {confirmingId === connection.id ? "Confirm delete" : "Delete"}
          </button>
        </div>

        {connection.lastError ? (
          <div className="mt-4 rounded-lg border border-rose-400/25 bg-rose-400/10 p-3">
            <p className="text-xs text-rose-200">{connection.lastError.message}</p>
            <div className="mt-2 flex gap-2">
              <input value={rotateTokens[connection.id] ?? ""} onChange={(event) => setRotateTokens((current) => ({ ...current, [connection.id]: event.target.value }))} type="password" autoComplete="off" placeholder="New token (or retry stored)" className={inputClass} />
              <button type="button" onClick={() => void retry(connection)} disabled={busy === `retry:${connection.id}`} className="rounded-lg border border-rose-300/30 px-3 text-xs text-rose-200 disabled:opacity-50">Retry</button>
            </div>
          </div>
        ) : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <FormField label="DM policy">
            <select value={draft.dmPolicy} onChange={(event) => setDrafts((current) => ({ ...current, [connection.id]: { ...draft, dmPolicy: event.target.value as ConnectionDraft["dmPolicy"] } }))} className={inputClass}>
              <option value="pairing">Pairing approval</option>
              <option value="allowlist">Allowlist only</option>
            </select>
          </FormField>
          <FormField label="Allowed user IDs">
            <input value={draft.allowFrom} onChange={(event) => setDrafts((current) => ({ ...current, [connection.id]: { ...draft, allowFrom: event.target.value } }))} placeholder="123456789, 987654321" className={inputClass} />
          </FormField>
        </div>

        {connection.channel === "discord" ? (
          <div className="mt-3 rounded-lg border border-edge bg-background/50 p-3">
            <p className="font-mono text-[10px] uppercase tracking-wider text-faint">Direct messages only</p>
            <p className="mt-2 text-xs text-muted">
              Guild and channel delivery is disabled so shared transcripts cannot access private user memory.
            </p>
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          {connection.desiredState === "active" ? (
            <>
              <button type="button" onClick={() => void activate(connection)} disabled={busy === `activate:${connection.id}`} className="rounded-lg border border-accent/30 px-3 py-2 text-xs text-accent-soft disabled:opacity-50">{busy === `activate:${connection.id}` ? "Saving…" : "Save access"}</button>
              <button type="button" onClick={() => void deactivate(connection)} disabled={busy === `deactivate:${connection.id}`} className="rounded-lg border border-edge px-3 py-2 text-xs text-muted disabled:opacity-50">Deactivate</button>
            </>
          ) : (
            <button type="button" onClick={() => void activate(connection)} disabled={connection.observedState === "error" || busy === `activate:${connection.id}`} className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent-soft disabled:opacity-40">{busy === `activate:${connection.id}` ? "Activating…" : "Activate"}</button>
          )}
          <button type="button" onClick={() => void loadPairing(connection)} disabled={busy === `pairing:${connection.id}`} className="rounded-lg border border-edge px-3 py-2 text-xs text-muted disabled:opacity-50">
            Pending requests{pending.length ? ` (${pending.length})` : ""}
          </button>
          {clientLink ? <a href={clientLink} target="_blank" rel="noreferrer" className="rounded-lg border border-edge px-3 py-2 text-xs text-muted">Open in {LABELS[connection.channel]}</a> : null}
          {inviteLink ? <a href={inviteLink} target="_blank" rel="noreferrer" className="rounded-lg border border-edge px-3 py-2 text-xs text-muted">Invite bot to Discord</a> : null}
        </div>

        {pairings[connection.id] ? (
          <div className="mt-3 border-t border-edge pt-3">
            {pending.length === 0 ? <p className="text-xs text-faint">No pending pairing requests.</p> : (
              <ul className="space-y-2">
                {pending.map((request) => {
                  const linkToMyAccount = pairingLinks[request.id] ?? false;
                  const code = pairingCodes[request.id] ?? "";
                  return (
                    <li key={request.id} className="rounded-lg bg-background px-3 py-2">
                      <div className="flex items-start justify-between gap-3">
                        <div><p className="text-xs text-muted">Sender ••••{request.peerPreview ?? "unknown"}</p><p className="text-[10px] text-faint">Requested {formatRelativeTime(request.requestedAt)}</p></div>
                        <div className="flex gap-2">
                          <button type="button" disabled={busy === `pairing:${request.id}`} onClick={() => void decidePairing(connection, request, "deny")} className="text-xs text-rose-300 disabled:opacity-40">Deny</button>
                          <button type="button" disabled={busy === `pairing:${request.id}` || (linkToMyAccount && !code.trim())} onClick={() => void decidePairing(connection, request, "approve")} className="text-xs text-emerald-300 disabled:opacity-40">Approve</button>
                        </div>
                      </div>
                      <label className="mt-2 flex items-start gap-2 text-xs text-muted">
                        <input
                          type="checkbox"
                          checked={linkToMyAccount}
                          onChange={(event) => setPairingLinks((current) => ({ ...current, [request.id]: event.target.checked }))}
                        />
                        <span>This sender is me — link to my Eden account and shared web memory.</span>
                      </label>
                      {linkToMyAccount ? (
                        <input
                          value={code}
                          onChange={(event) => setPairingCodes((current) => ({ ...current, [request.id]: event.target.value }))}
                          type="password"
                          autoComplete="one-time-code"
                          placeholder="Enter the one-time code shown by the bot"
                          maxLength={128}
                          className={`${inputClass} mt-2`}
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
      </li>
    );
  };

  const renderXConnection = (connection: XConnectionDto) => {
    const clientLink = xClientDeepLink(connection);
    const action = xFailureAction(connection.lastError?.code ?? null);
    return (
      <li key={connection.id} className="rounded-xl border border-edge bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">{connection.label || connection.user?.name || "X app"}</h3>
              <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${connection.status === "active" || connection.status === "verified" ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300" : "border-rose-400/25 bg-rose-400/10 text-rose-300"}`}>
                {connection.status}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">X · Credential encrypted{connection.user?.username ? ` · @${connection.user.username}` : ""}</p>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-faint">Updated {formatRelativeTime(connection.updatedAt)}</p>
          </div>
          <button type="button" onClick={() => void revokeX(connection)} disabled={busy === `revoke:x:${connection.id}`} className="rounded-lg border border-rose-400/30 px-3 py-1.5 text-xs text-rose-300 disabled:opacity-40">Revoke</button>
        </div>
        {connection.lastError ? (
          <div className="mt-3 rounded-lg border border-rose-400/25 bg-rose-400/10 p-3 text-xs text-rose-200">
            <p>{connection.lastError.message}</p>
            {action ? <p className="mt-1 text-rose-100/80">{action}</p> : null}
          </div>
        ) : null}
        {clientLink ? <a href={clientLink} target="_blank" rel="noreferrer" className="mt-3 inline-block rounded-lg border border-edge px-3 py-2 text-xs text-muted">Open profile on X</a> : null}
      </li>
    );
  };

  const ownerBindingLink = trustedTelegramUrl(telegramOwnerBindingUrl);
  const managedBotLink = trustedTelegramUrl(telegramOnboarding?.managedBotUrl);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-14 md:px-10">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">Autonomy</p>
        <h1 className="mt-2 text-3xl font-light tracking-tight md:text-4xl">Connections</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Give an agent its own Discord or Telegram bot, or connect your own X developer app.
          Credentials are encrypted and are never shown again.
        </p>
      </header>

      {phase === "ready" && agents.length > 0 ? (
        <div className="mt-8 max-w-sm">
          <FormField label="Agent">
            <select
              value={selectedAgentId ?? ""}
              onChange={(event) => selectAgent(event.target.value)}
              className={inputClass}
            >
              {sortedAgents.map((agent) => {
                const count = connectionCounts.get(agent.id) ?? 0;
                return (
                  <option key={agent.id} value={agent.id}>
                    {agentLabel(agent)}{count ? ` — ${count} bot${count === 1 ? "" : "s"}` : ""}
                  </option>
                );
              })}
            </select>
          </FormField>
        </div>
      ) : null}

      {note ? (
        <p role="status" className="mt-6 rounded-lg border border-accent/25 bg-accent/10 px-3 py-2 text-xs text-accent-soft">
          {note}
        </p>
      ) : null}

      {phase === "loading" ? (
        <div className="mt-10"><SkeletonRows count={4} /></div>
      ) : phase === "error" ? (
        <div className="mt-10">
          <EmptyState title="Couldn’t load connections" hint={note ?? undefined} action={<button type="button" onClick={() => void load()} className="rounded-lg border border-edge px-3 py-2 text-sm text-muted">Retry</button>} />
        </div>
      ) : agents.length === 0 ? (
        <div className="mt-10 space-y-8">
          <EmptyState
            title="No agents yet"
            hint={unassignedConnections.length || unassignedXConnections.length
              ? "Create an agent to connect something new. Existing unassigned credentials remain available for revocation below."
              : "Connections give one of your agents a bot of its own — create an agent first."}
            action={<a href="/agents/new" className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-accent-soft">Create an agent</a>}
          />
          {unassignedConnections.length > 0 ? (
            <section>
              <h2 className="font-mono text-[10px] uppercase tracking-[0.25em] text-faint">Unassigned bot credentials</h2>
              <ul className="mt-3 space-y-4">{unassignedConnections.map(renderConnection)}</ul>
            </section>
          ) : null}
          {unassignedXConnections.length > 0 ? (
            <section>
              <h2 className="font-mono text-[10px] uppercase tracking-[0.25em] text-faint">Unassigned X app credentials</h2>
              <ul className="mt-3 space-y-4">{unassignedXConnections.map(renderXConnection)}</ul>
            </section>
          ) : null}
        </div>
      ) : (
        <>
        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
          <form onSubmit={(event) => void create(event)} className="h-fit rounded-xl border border-edge bg-surface p-4">
            <h2 className="text-sm font-medium">
              Connect a bot{selectedAgent ? ` to ${selectedAgent.name ?? `@${selectedAgent.username}`}` : ""}
            </h2>
            <div className="mt-5 space-y-4">
              <FormField label="Provider">
                <select value={channel} onChange={(event) => setChannel(event.target.value as ChannelKind)} className={inputClass}>
                  {CHANNELS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </FormField>
              {channel === "discord" ? (
                <>
                  <div className="rounded-lg border border-edge bg-background/50 p-3 text-xs text-muted">
                    <p className="font-medium text-foreground">Discord BYOB walkthrough</p>
                    <ol className="mt-2 list-decimal space-y-1.5 pl-4">
                      <li><a href={DISCORD_DEVELOPER_PORTAL} target="_blank" rel="noreferrer" className="text-accent-soft underline underline-offset-2">Open the Discord developer portal</a> and create an application.</li>
                      <li>Open Bot, add a bot, then copy its token. Never paste a user token.</li>
                      <li>Save below. Eden validates it with Discord’s bot identity endpoint.</li>
                      <li>After validation, use the fixed-permission invite shown on the connection.</li>
                    </ol>
                  </div>
                  <FormField label="Bot token">
                    <input value={token} onChange={(event) => setToken(event.target.value)} type="password" autoComplete="off" placeholder="••••••••" className={inputClass} />
                  </FormField>
                </>
              ) : (
                <div className="rounded-lg border border-edge bg-background/50 p-3 text-xs text-muted">
                  <p className="font-medium text-foreground">Telegram Managed Bots</p>
                  <ol className="mt-2 list-decimal space-y-1.5 pl-4">
                    <li className={telegramStep === "bind_owner" ? "text-foreground" : undefined}>Confirm your Eden account in Telegram.</li>
                    <li className={telegramStep === "choose_bot" ? "text-foreground" : undefined}>Choose or create a bot in the managed onboarding chat.</li>
                    <li className={telegramStep === "attach" ? "text-foreground" : undefined}>Attach the securely stored bot to this agent.</li>
                  </ol>
                  {telegramOnboarding ? (
                    <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-faint">
                      {telegramOnboarding.intent.state.replaceAll("_", " ")} · expires {formatRelativeTime(telegramOnboarding.intent.expiresAt)}
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {ownerBindingLink && telegramStep === "bind_owner" ? (
                      <a href={ownerBindingLink} target="_blank" rel="noreferrer" className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent-soft">Confirm ownership in Telegram</a>
                    ) : null}
                    {managedBotLink && telegramStep === "choose_bot" ? (
                      <a href={managedBotLink} target="_blank" rel="noreferrer" className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent-soft">Open Managed Bots</a>
                    ) : null}
                    {telegramStep === "attach" ? (
                      <button type="button" onClick={() => void attachManagedTelegram()} disabled={busy?.startsWith("telegram:") || !selectedAgent} className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent-soft disabled:opacity-50">{busy === "telegram:attach" ? "Attaching…" : "Attach to agent"}</button>
                    ) : null}
                    {telegramOnboarding && telegramStep !== "terminal" && telegramStep !== "complete" ? (
                      <button type="button" onClick={() => void cancelManagedTelegram()} disabled={busy?.startsWith("telegram:")} className="rounded-lg border border-edge px-3 py-2 text-xs text-muted disabled:opacity-50">Cancel</button>
                    ) : null}
                    {telegramOnboarding && (telegramStep === "terminal" || telegramStep === "complete") ? (
                      <button type="button" onClick={resetManagedTelegram} className="rounded-lg border border-edge px-3 py-2 text-xs text-muted">Start over</button>
                    ) : null}
                  </div>
                </div>
              )}
              {channel === "telegram" && !telegramOnboarding ? (
                <FormField label="Suggested bot username (optional)">
                  <input value={telegramSuggestedUsername} onChange={(event) => setTelegramSuggestedUsername(event.target.value)} placeholder="my_eden_bot" maxLength={32} autoComplete="off" className={inputClass} />
                </FormField>
              ) : null}
              <FormField label="Label (optional)">
                <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Community bot" maxLength={120} className={inputClass} />
              </FormField>
            </div>
            {channel === "discord" ? (
              <button type="submit" disabled={busy === "create" || !selectedAgent} className="mt-5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white hover:bg-accent/85 disabled:opacity-50">
                {busy === "create" ? "Validating…" : "Save & validate"}
              </button>
            ) : !telegramOnboarding ? (
              <button type="submit" disabled={busy === "telegram:start" || !selectedAgent} className="mt-5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white hover:bg-accent/85 disabled:opacity-50">
                {busy === "telegram:start" ? "Starting…" : "Start managed onboarding"}
              </button>
            ) : null}
          </form>

          <div>
            {agentConnections.length === 0 ? (
              <EmptyState
                title={selectedAgent ? `No bots for @${selectedAgent.username} yet` : "No connections yet"}
                hint="Add a Discord or Telegram bot with the form on the left."
              />
            ) : (
              <ul className="space-y-4">{agentConnections.map(renderConnection)}</ul>
            )}

            {unassignedConnections.length > 0 ? (
              <div className="mt-8">
                <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-faint">
                  Not linked to any of your agents
                </p>
                <ul className="mt-3 space-y-4">{unassignedConnections.map(renderConnection)}</ul>
              </div>
            ) : null}
          </div>
        </div>
        <section className="mt-12 border-t border-edge pt-8">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-faint">User-owned publishing</p>
            <h2 className="mt-2 text-xl font-light">X developer app</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">Connect credentials from an app you own. X bills API usage to your developer account; Eden encrypts the credentials and posts only when you ask.</p>
          </div>
          <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
            <form onSubmit={(event) => void connectX(event)} className="h-fit rounded-xl border border-edge bg-surface p-4">
              <div className="rounded-lg border border-edge bg-background/50 p-3 text-xs text-muted">
                <ol className="list-decimal space-y-1.5 pl-4">
                  <li><a href={X_DEVELOPER_PORTAL} target="_blank" rel="noreferrer" className="text-accent-soft underline underline-offset-2">Open the X developer portal</a> and create or select your app.</li>
                  <li>Enable read and write access, then generate user access tokens.</li>
                  <li>Paste all four values once. They are validated before encrypted storage.</li>
                </ol>
              </div>
              <div className="mt-4 space-y-3">
                <FormField label="API key"><input type="password" autoComplete="off" value={xCredentials.apiKey} onChange={(event) => setXCredentials((current) => ({ ...current, apiKey: event.target.value }))} className={inputClass} /></FormField>
                <FormField label="API key secret"><input type="password" autoComplete="off" value={xCredentials.apiSecret} onChange={(event) => setXCredentials((current) => ({ ...current, apiSecret: event.target.value }))} className={inputClass} /></FormField>
                <FormField label="Access token"><input type="password" autoComplete="off" value={xCredentials.accessToken} onChange={(event) => setXCredentials((current) => ({ ...current, accessToken: event.target.value }))} className={inputClass} /></FormField>
                <FormField label="Access token secret"><input type="password" autoComplete="off" value={xCredentials.accessTokenSecret} onChange={(event) => setXCredentials((current) => ({ ...current, accessTokenSecret: event.target.value }))} className={inputClass} /></FormField>
                <FormField label="Label (optional)"><input value={xLabel} onChange={(event) => setXLabel(event.target.value)} maxLength={120} placeholder="Publishing app" className={inputClass} /></FormField>
              </div>
              <button type="submit" disabled={busy === "create:x" || !selectedAgent} className="mt-5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white disabled:opacity-50">{busy === "create:x" ? "Validating…" : "Validate & connect"}</button>
            </form>
            <div>
              {agentXConnections.length === 0 ? <EmptyState title="No X app connected" hint="Connect a user-owned developer app to publish from this agent." /> : <ul className="space-y-4">{agentXConnections.map(renderXConnection)}</ul>}
              {unassignedXConnections.length > 0 ? (
                <div className="mt-8">
                  <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-faint">X apps not linked to one of your agents</p>
                  <ul className="mt-3 space-y-4">{unassignedXConnections.map(renderXConnection)}</ul>
                </div>
              ) : null}
            </div>
          </div>
        </section>
        </>
      )}
    </div>
  );
}
