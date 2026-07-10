"use client";

/**
 * /channels — user-owned channel token custody and sandbox routing checks.
 *
 * Tokens are submitted once to the API and never rendered again. The list uses
 * the safe DTO from GET /channels/connections: status, channel, label, last-four
 * token preview, and timestamps.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, isEndpointMissing } from "@/lib/api";
import type {
  ChannelConnectionCreateInput,
  ChannelConnectionDto,
  ChannelKind,
  ChannelMockMessageResult,
} from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { SkeletonRows } from "@/components/skeleton";
import { formatRelativeTime } from "@/lib/format";

const CHANNELS: Array<{ value: ChannelKind; label: string }> = [
  { value: "discord", label: "Discord" },
  { value: "telegram", label: "Telegram" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "slack", label: "Slack" },
  { value: "voice", label: "Voice" },
];

const CHANNEL_LABELS = Object.fromEntries(
  CHANNELS.map((item) => [item.value, item.label]),
) as Record<ChannelKind, string>;

type Phase = "loading" | "ready" | "error";

function errorCopy(error: unknown): { title: string; hint: string } {
  if (isEndpointMissing(error)) {
    return {
      title: "Channels aren't wired up yet",
      hint: "GET /api/channels/connections is still landing in the backend workflow.",
    };
  }
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return {
        title: "No user selected",
        hint: "Pick a dev user in the sidebar switcher to manage channels.",
      };
    }
    if (error.status === 503) {
      return {
        title: "Secret vault unavailable",
        hint: error.message,
      };
    }
    return { title: "Couldn't load channels", hint: error.message };
  }
  return {
    title: "API offline",
    hint: "Start @eden3/api on :4301 and retry.",
  };
}

function statusTone(status: string): string {
  const key = status.toLowerCase();
  if (key === "connected") {
    return "border-emerald-400/25 bg-emerald-400/10 text-emerald-300";
  }
  if (key === "error") {
    return "border-rose-400/25 bg-rose-400/10 text-rose-300";
  }
  return "border-edge bg-white/[0.04] text-muted";
}

function tokenPreview(connection: ChannelConnectionDto): string {
  return connection.tokenPreview ? `•••• ${connection.tokenPreview}` : "stored";
}

function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
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
  const [connections, setConnections] = useState<ChannelConnectionDto[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [loadError, setLoadError] = useState<unknown>(null);
  const [channel, setChannel] = useState<ChannelKind>("discord");
  const [label, setLabel] = useState("");
  const [agentUsername, setAgentUsername] = useState("");
  const [token, setToken] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mockMessages, setMockMessages] = useState<Record<string, string>>({});
  const [mockResults, setMockResults] = useState<
    Record<string, ChannelMockMessageResult | string>
  >({});
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const alive = useRef(true);
  const confirmTimer = useRef<number | null>(null);

  const load = useCallback(async (soft = false) => {
    if (!soft) setPhase("loading");
    try {
      const { items } = await api.channels.list();
      if (!alive.current) return;
      setConnections(items);
      setPhase("ready");
      setLoadError(null);
    } catch (error) {
      if (!alive.current) return;
      if (soft) setNote(errorCopy(error).hint);
      else {
        setLoadError(error);
        setPhase("error");
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      if (confirmTimer.current != null) window.clearTimeout(confirmTimer.current);
    };
  }, [load]);

  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote(null), 7000);
    return () => window.clearTimeout(timer);
  }, [note]);

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      setNote("Token is required.");
      return;
    }
    setBusy("create");
    setNote(null);
    const input: ChannelConnectionCreateInput = {
      channel,
      token: trimmedToken,
    };
    const trimmedLabel = label.trim();
    const trimmedAgent = agentUsername.trim().replace(/^@/, "");
    if (trimmedLabel) input.label = trimmedLabel;
    if (trimmedAgent) input.agentUsername = trimmedAgent;
    try {
      const created = await api.channels.create(input);
      if (!alive.current) return;
      setConnections((prev) => [created, ...prev]);
      setLabel("");
      setAgentUsername("");
      setToken("");
      setChannel("discord");
    } catch (error) {
      if (alive.current) setNote(errorCopy(error).hint);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const sendMock = async (connection: ChannelConnectionDto) => {
    const message = (mockMessages[connection.id] ?? "").trim();
    if (!message) {
      setMockResults((prev) => ({
        ...prev,
        [connection.id]: "Message is required.",
      }));
      return;
    }
    setBusy(`mock:${connection.id}`);
    try {
      const result = await api.channels.mockMessage(connection.id, message);
      if (!alive.current) return;
      setMockResults((prev) => ({ ...prev, [connection.id]: result }));
      setMockMessages((prev) => ({ ...prev, [connection.id]: "" }));
    } catch (error) {
      if (alive.current) {
        setMockResults((prev) => ({
          ...prev,
          [connection.id]: errorCopy(error).hint,
        }));
      }
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const remove = async (connection: ChannelConnectionDto) => {
    if (confirmingId !== connection.id) {
      setConfirmingId(connection.id);
      if (confirmTimer.current != null) window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(
        () => setConfirmingId(null),
        4000,
      );
      return;
    }
    setConfirmingId(null);
    setBusy(`delete:${connection.id}`);
    try {
      await api.channels.delete(connection.id);
      if (!alive.current) return;
      setConnections((prev) => prev.filter((item) => item.id !== connection.id));
    } catch (error) {
      if (alive.current) setNote(errorCopy(error).hint);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-edge bg-background px-3 py-2 text-sm text-foreground placeholder:text-faint focus:border-accent/60 focus:outline-none";

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-14 md:px-10">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
          Autonomy
        </p>
        <h1 className="mt-2 text-3xl font-light tracking-tight md:text-4xl">
          Channels
        </h1>
        <p className="mt-2 text-sm text-muted">
          Connect agents to external channel endpoints.
        </p>
      </header>

      {note ? (
        <p
          role="status"
          className="mt-6 rounded-lg border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-xs text-rose-300"
        >
          {note}
        </p>
      ) : null}

      <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <form
          onSubmit={(event) => void create(event)}
          className="rounded-xl border border-edge bg-surface p-4"
        >
          <h2 className="text-sm font-medium">New connection</h2>
          <div className="mt-5 space-y-4">
            <FormField label="Channel">
              <select
                value={channel}
                onChange={(event) => setChannel(event.target.value as ChannelKind)}
                className={inputClass}
              >
                {CHANNELS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </FormField>

            <FormField label="Label">
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Team workspace"
                maxLength={120}
                className={inputClass}
              />
            </FormField>

            <FormField label="Agent">
              <input
                value={agentUsername}
                onChange={(event) => setAgentUsername(event.target.value)}
                placeholder="@abraham"
                maxLength={200}
                className={inputClass}
              />
            </FormField>

            <FormField label="Token">
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="••••••••"
                type="password"
                autoComplete="off"
                className={inputClass}
              />
            </FormField>
          </div>

          <button
            type="submit"
            disabled={busy === "create"}
            className="mt-5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "create" ? "Saving…" : "Connect"}
          </button>
        </form>

        <div>
          {phase === "loading" ? (
            <SkeletonRows count={4} />
          ) : phase === "error" ? (
            <EmptyState
              {...errorCopy(loadError)}
              action={
                <button
                  type="button"
                  onClick={() => void load()}
                  className="rounded-lg border border-edge px-3.5 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
                >
                  Retry
                </button>
              }
            />
          ) : connections.length === 0 ? (
            <EmptyState
              title="No channels connected"
              hint="Create a connection to route sandbox channel messages."
            />
          ) : (
            <ul className="space-y-3">
              {connections.map((connection) => {
                const mock = mockResults[connection.id];
                const mockBusy = busy === `mock:${connection.id}`;
                const deleteBusy = busy === `delete:${connection.id}`;
                return (
                  <li
                    key={connection.id}
                    className="rounded-xl border border-edge bg-surface p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-medium">
                            {connection.label ||
                              CHANNEL_LABELS[connection.channel] ||
                              connection.channel}
                          </h3>
                          <span
                            className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${statusTone(connection.status)}`}
                          >
                            {connection.status}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted">
                          {CHANNEL_LABELS[connection.channel]} ·{" "}
                          {tokenPreview(connection)}
                          {connection.agentId ? (
                            <span className="text-faint">
                              {" "}
                              · agent {connection.agentId.slice(0, 8)}
                            </span>
                          ) : null}
                        </p>
                        <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-faint">
                          Updated {formatRelativeTime(connection.updatedAt)}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={deleteBusy}
                        onClick={() => void remove(connection)}
                        className={`rounded-lg border px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          confirmingId === connection.id
                            ? "border-rose-400/50 bg-rose-400/10 text-rose-300"
                            : "border-edge text-muted hover:border-rose-400/50 hover:text-rose-300"
                        }`}
                      >
                        {confirmingId === connection.id ? "Confirm" : "Delete"}
                      </button>
                    </div>

                    <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                      <input
                        value={mockMessages[connection.id] ?? ""}
                        onChange={(event) =>
                          setMockMessages((prev) => ({
                            ...prev,
                            [connection.id]: event.target.value,
                          }))
                        }
                        placeholder="Sandbox message"
                        maxLength={4000}
                        className={inputClass}
                      />
                      <button
                        type="button"
                        disabled={mockBusy}
                        onClick={() => void sendMock(connection)}
                        className="rounded-lg border border-edge px-3.5 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {mockBusy ? "Routing…" : "Test"}
                      </button>
                    </div>

                    {mock ? (
                      <p
                        role="status"
                        className={`mt-2 text-xs ${
                          typeof mock === "string"
                            ? "text-rose-300"
                            : "text-emerald-300"
                        }`}
                      >
                        {typeof mock === "string"
                          ? mock
                          : `Routed ${mock.messageLength} characters through ${CHANNEL_LABELS[mock.channel]}.`}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
