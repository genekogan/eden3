"use client";

/**
 * /manna — balance hero + transaction ledger.
 *
 * GET /api/manna feeds the hero (total with balance/subscription split);
 * GET /api/manna/transactions?cursor feeds the ledger (newest first,
 * "Load more" walks the cursor). The hero stays live: any active SSE stream
 * broadcasts manna.updated through lib/api's manna bus and we refetch.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  api,
  ApiError,
  emitMannaUpdate,
  isEndpointMissing,
  onMannaUpdate,
} from "@/lib/api";
import type { MannaSummary, MannaTransactionDto } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { Skeleton, SkeletonRows } from "@/components/skeleton";
import { formatDateTime, formatMannaExact } from "@/lib/format";

function errorCopy(error: unknown): { title: string; hint: string } {
  if (isEndpointMissing(error)) {
    return {
      title: "Manna isn't wired up yet",
      hint: "The manna endpoints are still landing in the backend workflow — this page lights up as soon as they ship.",
    };
  }
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return {
        title: "No user selected",
        hint: "Pick a dev user in the sidebar switcher to see their balance.",
      };
    }
    return { title: "Couldn't load manna", hint: error.message };
  }
  return { title: "API offline", hint: "Start @eden3/api on :4301 and retry." };
}

function MannaGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className ?? "size-5"}
    >
      <path d="M6 3h12l4 6-10 13L2 9z" />
      <path d="M11 3 8 9l4 13 4-13-3-6M2 9h20" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Transaction row bits
// ---------------------------------------------------------------------------

/** Chip tone by transaction type keyword — violet for refunds/subscription, green for credits, quiet for spends. */
function typeTone(type: string): string {
  const t = type.toLowerCase();
  if (t.includes("refund") || t.includes("subscription")) {
    return "border-accent/40 bg-accent/10 text-accent-soft";
  }
  if (t.includes("credit") || t.includes("grant") || t.includes("topup")) {
    return "border-emerald-400/25 bg-emerald-400/10 text-emerald-300";
  }
  return "border-edge bg-white/[0.04] text-muted";
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

function TransactionRow({ tx }: { tx: MannaTransactionDto }) {
  const positive = tx.amount > 0;
  const amountTone = positive
    ? "text-emerald-300"
    : tx.amount < 0
      ? "text-rose-300"
      : "text-muted";
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 sm:px-5">
      <span
        className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${typeTone(tx.type)}`}
      >
        {tx.type.replace(/_/g, " ")}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">
        {tx.taskExternalId ? `task ${shortId(tx.taskExternalId)}` : null}
        {tx.taskExternalId && tx.refundsTransactionId ? " · " : null}
        {tx.refundsTransactionId
          ? `refunds ${shortId(tx.refundsTransactionId)}`
          : null}
      </span>
      <time
        dateTime={tx.createdAt}
        title={tx.createdAt}
        className="shrink-0 text-xs text-faint"
      >
        {formatDateTime(tx.createdAt)}
      </time>
      <span
        className={`w-24 shrink-0 text-right font-mono text-sm tabular-nums ${amountTone}`}
      >
        {positive ? "+" : ""}
        {formatMannaExact(tx.amount)}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Phase = "loading" | "ready" | "error";
type CheckoutTarget = "manna" | "basic" | "pro" | "believer";

const SUBSCRIPTION_TIERS: Array<{
  tier: "basic" | "pro" | "believer";
  label: string;
}> = [
  { tier: "basic", label: "Basic" },
  { tier: "pro", label: "Pro" },
  { tier: "believer", label: "Believer" },
];

export function MannaClient() {
  const [summary, setSummary] = useState<MannaSummary | null>(null);
  const [summaryPhase, setSummaryPhase] = useState<Phase>("loading");
  const [summaryError, setSummaryError] = useState<unknown>(null);

  const [transactions, setTransactions] = useState<MannaTransactionDto[]>([]);
  const [txPhase, setTxPhase] = useState<Phase>("loading");
  const [txError, setTxError] = useState<unknown>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState<CheckoutTarget | null>(null);
  const [voucherCode, setVoucherCode] = useState("");
  const [voucherBusy, setVoucherBusy] = useState(false);
  const [billingNote, setBillingNote] = useState<string | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);
  const alive = useRef(true);

  const loadSummary = useCallback(async () => {
    try {
      const result = await api.manna.get();
      if (!alive.current) return;
      setSummary(result);
      setSummaryPhase("ready");
    } catch (error) {
      if (!alive.current) return;
      setSummaryError(error);
      setSummaryPhase("error");
    }
  }, []);

  const loadTransactions = useCallback(async () => {
    setTxPhase("loading");
    try {
      const page = await api.manna.transactions();
      if (!alive.current) return;
      setTransactions(page.items);
      setNextCursor(page.nextCursor);
      setTxPhase("ready");
    } catch (error) {
      if (!alive.current) return;
      setTxError(error);
      setTxPhase("error");
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void loadSummary();
    void loadTransactions();
    // Live: any active stream broadcasts manna.updated -> refetch authority.
    const unsubscribe = onMannaUpdate((balance) => {
      if (balance !== undefined) {
        setSummary((prev) => (prev ? { ...prev, balance } : prev));
      }
      void loadSummary();
    });
    return () => {
      alive.current = false;
      unsubscribe();
    };
  }, [loadSummary, loadTransactions]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.manna.transactions(nextCursor);
      if (!alive.current) return;
      setTransactions((prev) => {
        const seen = new Set(prev.map((tx) => tx.id));
        return [...prev, ...page.items.filter((tx) => !seen.has(tx.id))];
      });
      setNextCursor(page.nextCursor);
    } catch {
      // Leave the button in place — retrying is the recovery path.
    } finally {
      if (alive.current) setLoadingMore(false);
    }
  };

  const startCheckout = async (target: CheckoutTarget) => {
    setCheckoutBusy(target);
    setBillingError(null);
    setBillingNote(null);
    try {
      const session =
        target === "manna"
          ? await api.billing.checkout({ kind: "manna_topup" })
          : await api.billing.checkout({ kind: "subscription", tier: target });
      if (!session.url) {
        setBillingError("Stripe did not return a checkout URL.");
        return;
      }
      window.location.assign(session.url);
    } catch (error) {
      setBillingError(error instanceof Error ? error.message : "Checkout failed.");
    } finally {
      if (alive.current) setCheckoutBusy(null);
    }
  };

  const redeemVoucher = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = voucherCode.trim();
    if (!code || voucherBusy) return;
    setVoucherBusy(true);
    setBillingError(null);
    setBillingNote(null);
    try {
      const result = await api.billing.redeemVoucher(code);
      setVoucherCode("");
      setBillingNote(
        result.alreadyApplied
          ? "Voucher already applied."
          : `Voucher applied: +${formatMannaExact(result.amount)} manna.`,
      );
      emitMannaUpdate();
      await Promise.all([loadSummary(), loadTransactions()]);
    } catch (error) {
      setBillingError(error instanceof Error ? error.message : "Voucher failed.");
    } finally {
      if (alive.current) setVoucherBusy(false);
    }
  };

  const total =
    summary != null ? summary.balance + summary.subscriptionBalance : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-14 md:px-10">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
          Account
        </p>
        <h1 className="mt-2 text-3xl font-light tracking-tight md:text-4xl">
          Manna
        </h1>
      </header>

      {/* Balance hero */}
      <section aria-label="Balance" className="mt-10">
        {summaryPhase === "loading" ? (
          <div className="rounded-xl border border-edge bg-surface p-6 md:p-8">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-4 h-12 w-48" />
            <div className="mt-6 flex gap-8">
              <Skeleton className="h-8 w-28" />
              <Skeleton className="h-8 w-28" />
            </div>
          </div>
        ) : summaryPhase === "error" ? (
          <EmptyState
            {...errorCopy(summaryError)}
            action={
              <button
                type="button"
                onClick={() => {
                  setSummaryPhase("loading");
                  void loadSummary();
                  if (txPhase === "error") void loadTransactions();
                }}
                className="rounded-lg border border-edge px-3.5 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
              >
                Retry
              </button>
            }
          />
        ) : summary ? (
          <div className="rounded-xl border border-edge bg-surface p-6 md:p-8">
            <div className="flex items-center gap-2 text-muted">
              <MannaGlyph className="size-4 text-accent-soft" />
              <span className="font-mono text-[10px] uppercase tracking-[0.2em]">
                Total balance
              </span>
            </div>
            <p
              className="mt-3 text-5xl font-light tabular-nums tracking-tight"
              title={total != null ? `${formatMannaExact(total)} manna` : undefined}
            >
              {formatMannaExact(total)}
            </p>
            <dl className="mt-6 flex flex-wrap gap-x-10 gap-y-3 border-t border-edge pt-5">
              <div>
                <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
                  Balance
                </dt>
                <dd className="mt-1 text-lg tabular-nums text-foreground">
                  {formatMannaExact(summary.balance)}
                </dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
                  Subscription
                </dt>
                <dd className="mt-1 text-lg tabular-nums text-foreground">
                  {formatMannaExact(summary.subscriptionBalance)}
                </dd>
              </div>
              {summary.updatedAt ? (
                <div className="ml-auto self-end text-right">
                  <dt className="sr-only">Updated</dt>
                  <dd className="text-xs text-faint">
                    as of {formatDateTime(summary.updatedAt)}
                  </dd>
                </div>
              ) : null}
            </dl>
            <div className="mt-6 border-t border-edge pt-5">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={checkoutBusy !== null}
                  onClick={() => void startCheckout("manna")}
                  className="rounded-lg border border-accent/45 bg-accent/10 px-3 py-2 text-sm text-accent-soft transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {checkoutBusy === "manna" ? "Opening…" : "Buy manna"}
                </button>
                {SUBSCRIPTION_TIERS.map(({ tier, label }) => (
                  <button
                    key={tier}
                    type="button"
                    disabled={checkoutBusy !== null}
                    onClick={() => void startCheckout(tier)}
                    className="rounded-lg border border-edge px-3 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {checkoutBusy === tier ? "Opening…" : label}
                  </button>
                ))}
              </div>
              <form
                onSubmit={(event) => void redeemVoucher(event)}
                className="mt-3 flex flex-col gap-2 sm:flex-row"
              >
                <input
                  value={voucherCode}
                  onChange={(event) => setVoucherCode(event.target.value)}
                  placeholder="Voucher code"
                  autoComplete="off"
                  className="min-w-0 flex-1 rounded-lg border border-edge bg-background px-3 py-2 text-sm placeholder:text-faint focus:border-accent/60 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={voucherBusy || voucherCode.trim().length === 0}
                  className="rounded-lg border border-edge px-3 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {voucherBusy ? "Redeeming…" : "Redeem"}
                </button>
              </form>
              {billingNote ? (
                <p className="mt-2 text-xs text-emerald-300">{billingNote}</p>
              ) : null}
              {billingError ? (
                <p className="mt-2 text-xs text-rose-300">{billingError}</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

      {/* Ledger */}
      <section aria-label="Transactions" className="mt-12">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground">Transactions</h2>
          {txPhase === "ready" ? (
            <button
              type="button"
              onClick={() => void loadTransactions()}
              className="text-xs text-faint transition-colors hover:text-foreground"
            >
              Refresh
            </button>
          ) : null}
        </div>

        <div className="mt-4">
          {txPhase === "loading" ? (
            <SkeletonRows count={6} />
          ) : txPhase === "error" ? (
            summaryPhase === "error" ? null : (
              <EmptyState
                {...errorCopy(txError)}
                action={
                  <button
                    type="button"
                    onClick={() => void loadTransactions()}
                    className="rounded-lg border border-edge px-3.5 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
                  >
                    Retry
                  </button>
                }
              />
            )
          ) : transactions.length === 0 ? (
            <EmptyState
              title="No transactions yet"
              hint="Chat turns, media generations, and top-ups will appear here."
            />
          ) : (
            <>
              <ul className="divide-y divide-edge/60 overflow-hidden rounded-xl border border-edge bg-surface">
                {transactions.map((tx) => (
                  <TransactionRow key={tx.id} tx={tx} />
                ))}
              </ul>
              {nextCursor ? (
                <div className="mt-4 flex justify-center">
                  <button
                    type="button"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                    className="rounded-lg border border-edge px-4 py-2 text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
