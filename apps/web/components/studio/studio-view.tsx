"use client";

/**
 * /studio — direct media generation with the OpenClaw tools.
 *
 * Flow: pick a tool (cards carry live per-tool manna prices from
 * GET /api/studio/tools, falling back to the canonical toolkit when the
 * registry isn't live) -> prompt (+ duration when the schema exposes it) ->
 * POST /api/studio/generate. The POST stays open until the file is ready
 * (image ~10–120s, video minutes): manna is decremented optimistically at
 * launch, a progress panel renders the wait, and the result lands in a
 * MediaFull/audio panel with a permalink. Failures refetch manna (refunds)
 * and offer retry. Recent creations strip at the bottom.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/skeleton";
import { api, emitMannaUpdate, onMannaUpdate } from "@/lib/api";
import type {
  MannaSummary,
  StudioGeneration,
  StudioGenerationQuote,
  StudioTool,
} from "@/lib/types";
import {
  FALLBACK_TOOLS,
  buildArgs,
  categorizeTool,
  defaultModelKey,
  describeFailure,
  durationSpec,
  modelOptions,
  promptKey,
  promptPlaceholder,
  sortTools,
  toolLabel,
  type GenerateFailure,
} from "./catalog";
import { GenerationProgress } from "./generation-progress";
import { MannaAmount } from "./manna-amount";
import { studioPrefillFromSearch } from "./prefill";
import { RecentStrip, type StripItem } from "./recent-strip";
import { ResultPanel } from "./result-panel";
import { ToolPicker } from "./tool-picker";

type Phase =
  | { kind: "idle"; notice: string | null }
  | { kind: "generating"; startedAt: number }
  | { kind: "done"; result: StudioGeneration }
  | { kind: "error"; failure: GenerateFailure };

type ToolsState =
  | { status: "loading" }
  | { status: "ready"; tools: StudioTool[]; live: boolean };

type QuoteState =
  | { status: "idle" }
  | { status: "loading"; key: string }
  | { status: "ready"; key: string; quote: StudioGenerationQuote }
  | { status: "error"; key: string };

const IDLE: Phase = { kind: "idle", notice: null };

export function StudioView({
  initialTool,
  hidePicker = false,
}: {
  initialTool?: string;
  /** Sidebar-driven mode: the tool list lives in the shell, not in-page. */
  hidePicker?: boolean;
} = {}) {
  const [toolsState, setToolsState] = useState<ToolsState>({ status: "loading" });
  const [selectedName, setSelectedName] = useState<string | null>(initialTool ?? null);
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState("");
  // "" = the tool's default model tier; a key from tool.models otherwise.
  const [model, setModel] = useState("");
  const [phase, setPhase] = useState<Phase>(IDLE);
  const [manna, setManna] = useState<MannaSummary | null>(null);
  const [sessionItems, setSessionItems] = useState<StripItem[]>([]);
  const [stripRefresh, setStripRefresh] = useState(0);
  const [quoteState, setQuoteState] = useState<QuoteState>({ status: "idle" });

  const alive = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const prefill = studioPrefillFromSearch(window.location.search);
    if (prefill.tool) setSelectedName(prefill.tool);
    if (prefill.prompt) setPrompt(prefill.prompt);
    if (prefill.duration) setDuration(prefill.duration);
  }, []);

  // ---- tools -------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tools = await api.studio.tools();
        if (cancelled) return;
        if (tools.length > 0) {
          setToolsState({ status: "ready", tools: sortTools(tools), live: true });
          return;
        }
      } catch {
        /* registry not live yet — fall back below */
      }
      if (!cancelled) {
        setToolsState({ status: "ready", tools: FALLBACK_TOOLS, live: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- manna balance (live via the app-wide manna bus) --------------------
  const refreshManna = useCallback(async () => {
    try {
      const summary = await api.manna.get();
      if (alive.current) setManna(summary);
    } catch {
      /* endpoint may 501 — leave unknown, don't gate */
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refreshManna();
    const unsubscribe = onMannaUpdate((balance) => {
      if (balance !== undefined) {
        setManna((prev) => (prev ? { ...prev, balance } : prev));
      } else {
        void refreshManna();
      }
    });
    return () => {
      alive.current = false;
      unsubscribe();
      abortRef.current?.abort();
    };
  }, [refreshManna]);

  // ---- derived -----------------------------------------------------------
  const tools = toolsState.status === "ready" ? toolsState.tools : [];
  const selected =
    tools.find((tool) => tool.name === selectedName) ?? tools[0] ?? null;
  const category = selected ? categorizeTool(selected) : "other";
  const tierOptions = selected ? modelOptions(selected) : [];
  const activeModelKey = model || (selected ? defaultModelKey(selected) : "");
  const activeTier = tierOptions.find((o) => o.key === activeModelKey) ?? null;
  const catalogCost =
    activeTier != null
      ? activeTier.costManna
      : selected && typeof selected.costManna === "number"
        ? selected.costManna
        : null;
  const quoteCost = quoteState.status === "ready" ? quoteState.quote.manna : null;
  const cost = quoteCost ?? catalogCost;
  const spendable = manna ? manna.balance + manna.subscriptionBalance : null;
  const insufficient =
    spendable != null && cost != null && spendable < cost;
  const trimmedPrompt = prompt.trim();
  const canGenerate =
    phase.kind !== "generating" &&
    selected != null &&
    trimmedPrompt !== "" &&
    !insufficient;

  // ---- live quote -------------------------------------------------------
  useEffect(() => {
    if (!selected || trimmedPrompt === "") {
      setQuoteState({ status: "idle" });
      return;
    }
    const args = buildArgs(selected, trimmedPrompt, duration, model);
    const key = `${selected.name}:${JSON.stringify(args)}`;
    let cancelled = false;
    setQuoteState((prev) => (prev.status === "ready" && prev.key === key ? prev : { status: "loading", key }));
    const timer = window.setTimeout(() => {
      void api.studio
        .quote({ tool: selected.name, args })
        .then((quote) => {
          if (!cancelled) setQuoteState({ status: "ready", key, quote });
        })
        .catch(() => {
          if (!cancelled) setQuoteState({ status: "error", key });
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selected, trimmedPrompt, duration, model]);

  // ---- actions -----------------------------------------------------------
  const selectTool = useCallback((name: string) => {
    setSelectedName(name);
    setDuration("");
    setModel("");
    setPhase((prev) => (prev.kind === "generating" ? prev : IDLE));
  }, []);

  const generate = useCallback(async () => {
    if (!selected || phase.kind === "generating" || trimmedPrompt === "") return;

    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: "generating", startedAt: Date.now() });

    // Optimistic decrement — the api debits up front; refetches reconcile.
    if (cost != null && manna) {
      const nextBalance = Math.max(0, manna.balance - cost);
      setManna({ ...manna, balance: nextBalance });
      emitMannaUpdate(nextBalance);
    }

    try {
      const result = await api.studio.generate(
        { tool: selected.name, args: buildArgs(selected, trimmedPrompt, duration, model) },
        { signal: controller.signal },
      );
      if (!alive.current) return;
      setPhase({ kind: "done", result });
      setSessionItems((prev) => [
        { id: result.creationId, url: result.url, tool: selected.name },
        ...prev.filter((item) => item.id !== result.creationId),
      ]);
      setStripRefresh((n) => n + 1);
      emitMannaUpdate(); // authoritative refetch everywhere
    } catch (error) {
      if (!alive.current) return;
      if (controller.signal.aborted) {
        setPhase({
          kind: "idle",
          notice:
            "Canceled. If the job had already started server-side, the result may still land in your creations.",
        });
      } else {
        setPhase({ kind: "error", failure: describeFailure(error) });
      }
      emitMannaUpdate(); // pick up the refund / undo the optimistic debit
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [selected, phase.kind, trimmedPrompt, duration, model, cost, manna]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ---- render ------------------------------------------------------------
  if (toolsState.status === "loading") {
    return (
      <div className="mt-8">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-hidden>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
        <Skeleton className="mt-4 h-52 rounded-xl" />
      </div>
    );
  }

  const spec = selected ? durationSpec(selected) : null;
  const speechInput = selected ? promptKey(selected) === "text" : false;

  return (
    <div className="mt-8">
      {!toolsState.live ? (
        <p className="mb-3 text-xs text-faint">
          Live tool registry unavailable — showing the standard toolkit with
          expected pricing.
        </p>
      ) : null}

      {hidePicker ? null : (
        <ToolPicker
          tools={tools}
          selectedName={selected?.name ?? null}
          onSelect={selectTool}
          disabled={phase.kind === "generating"}
        />
      )}

      <div className="mt-4">
        {phase.kind === "generating" && selected ? (
          <GenerationProgress
            startedAt={phase.startedAt}
            category={category}
            prompt={trimmedPrompt}
            toolLabel={toolLabel(selected)}
            onCancel={cancel}
          />
        ) : phase.kind === "done" ? (
          <ResultPanel
            result={phase.result}
            category={category}
            prompt={trimmedPrompt}
            cost={cost}
            onAgain={() => void generate()}
            onNewPrompt={() => setPhase(IDLE)}
          />
        ) : phase.kind === "error" ? (
          <ErrorPanel
            failure={phase.failure}
            onRetry={() => void generate()}
            onEdit={() => setPhase(IDLE)}
          />
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (canGenerate) void generate();
            }}
            className="rounded-xl border border-edge bg-surface p-5"
          >
            <div className="flex items-baseline justify-between gap-4">
              <label
                htmlFor="studio-prompt"
                className="text-xs font-medium uppercase tracking-wider text-faint"
              >
                {speechInput ? "Text" : "Prompt"}
              </label>
              {selected?.description ? (
                <p className="hidden min-w-0 truncate text-xs text-faint sm:block">
                  {selected.description}
                </p>
              ) : null}
            </div>
            <textarea
              id="studio-prompt"
              rows={4}
              autoFocus
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  if (canGenerate) void generate();
                }
              }}
              placeholder={promptPlaceholder(category)}
              className="mt-2 w-full resize-y rounded-lg border border-edge bg-raised p-3.5 text-sm leading-relaxed text-foreground placeholder:text-faint"
            />

            {tierOptions.length > 0 ? (
              <fieldset className="mt-3">
                <legend className="text-xs text-muted">Model</legend>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {tierOptions.map((option) => {
                    const active = option.key === activeModelKey;
                    return (
                      <label
                        key={option.key}
                        className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                          active
                            ? "border-accent/60 bg-accent/10 text-foreground"
                            : "border-edge bg-raised text-muted hover:text-foreground"
                        }`}
                      >
                        <input
                          type="radio"
                          name="studio-model"
                          className="sr-only"
                          checked={active}
                          onChange={() => setModel(option.key)}
                          disabled={phase.kind === "generating"}
                        />
                        <span>{option.label}</span>
                        <MannaAmount amount={option.costManna} className="text-faint" />
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ) : null}

            {spec ? (
              <div className="mt-3 flex items-center gap-3">
                <label htmlFor="studio-duration" className="text-xs text-muted">
                  Duration
                </label>
                <input
                  id="studio-duration"
                  type="number"
                  inputMode="numeric"
                  min={spec.min ?? 1}
                  {...(spec.max != null ? { max: spec.max } : {})}
                  value={duration}
                  onChange={(event) => setDuration(event.target.value)}
                  placeholder={
                    spec.defaultValue != null ? String(spec.defaultValue) : "auto"
                  }
                  className="w-24 rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm tabular-nums text-foreground placeholder:text-faint"
                />
                <span className="text-xs text-faint">seconds</span>
              </div>
            ) : null}

            {phase.kind === "idle" && phase.notice ? (
              <p className="mt-3 text-xs text-faint">{phase.notice}</p>
            ) : null}

            <div className="mt-4 flex items-center justify-between gap-4">
              <div className="min-w-0 text-xs text-faint">
                {insufficient ? (
                  <span>
                    Not enough manna for this tool.{" "}
                    <Link
                      href="/account/manna"
                      className="text-accent-soft transition-colors hover:text-accent"
                    >
                      Top up &rarr;
                    </Link>
                  </span>
                ) : spendable != null ? (
                  <span className="inline-flex items-center gap-1.5">
                    Balance
                    <MannaAmount amount={spendable} className="text-muted" />
                  </span>
                ) : null}
              </div>
              <button
                type="submit"
                disabled={!canGenerate}
                className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
              >
                Generate
                {cost != null ? (
                  <MannaAmount amount={cost} className="text-white/75" />
                ) : null}
              </button>
            </div>
          </form>
        )}
      </div>

      <RecentStrip sessionItems={sessionItems} refreshSignal={stripRefresh} />
    </div>
  );
}

function ErrorPanel({
  failure,
  onRetry,
  onEdit,
}: {
  failure: GenerateFailure;
  onRetry: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="rounded-xl border border-edge bg-surface p-6">
      <p className="text-sm font-medium text-danger-soft">{failure.title}</p>
      {failure.detail ? (
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          {failure.detail}
        </p>
      ) : null}
      {failure.refunded ? (
        <p className="mt-3 text-xs text-faint">
          Any manna charged for this attempt was refunded.
        </p>
      ) : null}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-soft"
        >
          Retry
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="rounded-lg border border-edge px-4 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
        >
          Edit prompt
        </button>
        {failure.insufficient ? (
          <Link
            href="/account/manna"
            className="ml-auto text-xs text-accent-soft transition-colors hover:text-accent"
          >
            Top up manna &rarr;
          </Link>
        ) : null}
      </div>
    </div>
  );
}
