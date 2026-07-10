"use client";

import Link from "next/link";
import React from "react";
import { useEffect, useState } from "react";
import { api, ApiError, isEndpointMissing } from "@/lib/api";
import type { AuthMeResponse, BillingSubscriptionSummary } from "@/lib/types";
import { formatDate, formatMannaExact } from "@/lib/format";

type Phase = "loading" | "ready" | "error";
type SettingsData = AuthMeResponse & {
  subscription: BillingSubscriptionSummary | null;
};

function errorCopy(error: unknown): { title: string; hint: string } {
  if (isEndpointMissing(error)) {
    return {
      title: "Settings are not wired yet",
      hint: "The auth endpoint is not available in this stack.",
    };
  }
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return {
      title: "No user selected",
      hint: "Sign in with Clerk or choose a local dev user to view account settings.",
    };
  }
  return {
    title: "Could not load settings",
    hint: error instanceof Error ? error.message : "Start the API and retry.",
  };
}

function AccountRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-t border-edge py-4 first:border-t-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm text-foreground">{value}</dd>
    </div>
  );
}

function labelForTier(tier: string | null): string {
  if (!tier) return "No tier";
  return tier.slice(0, 1).toUpperCase() + tier.slice(1);
}

export function SettingsSummary({ data }: { data: SettingsData }) {
  const user = data.user;
  const manna = data.manna;
  const subscription = data.subscription;
  const total =
    manna != null ? manna.balance + manna.subscriptionBalance : null;

  if (!user) {
    return (
      <section className="mt-10 rounded-xl border border-edge bg-surface p-6">
        <h2 className="text-lg font-medium">No account selected</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          Sign in with the inherited Eden account or select a local dev user to
          see settings.
        </p>
      </section>
    );
  }

  return (
    <div className="mt-10 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.75fr)]">
      <section className="rounded-xl border border-edge bg-surface p-6">
        <div className="flex flex-wrap items-center gap-4">
          {user.userImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.userImage}
              alt=""
              className="size-14 rounded-full border border-edge object-cover"
            />
          ) : (
            <div className="grid size-14 place-items-center rounded-full border border-edge bg-white/[0.04] font-mono text-lg uppercase text-accent-soft">
              {user.username.slice(0, 1)}
            </div>
          )}
          <div className="min-w-0">
            <h2 className="truncate text-2xl font-light">@{user.username}</h2>
            <p className="mt-1 text-sm text-muted">
              {user.type ?? "user"} account{user.isAdmin ? " · admin" : ""}
            </p>
          </div>
        </div>

        <dl className="mt-6">
          <AccountRow label="Account id" value={user.id} />
          <AccountRow label="Username" value={`@${user.username}`} />
          <AccountRow label="Account type" value={user.type ?? "user"} />
          <AccountRow label="Admin access" value={user.isAdmin ? "Enabled" : "Off"} />
        </dl>
      </section>

      <section className="rounded-xl border border-edge bg-surface p-6">
        <h2 className="text-lg font-medium">Billing and manna</h2>
        <dl className="mt-5 grid gap-4">
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
              Total balance
            </dt>
            <dd className="mt-1 text-3xl font-light tabular-nums">
              {formatMannaExact(total)}
            </dd>
          </div>
          <div className="grid grid-cols-2 gap-4 border-t border-edge pt-4">
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
                Durable
              </dt>
              <dd className="mt-1 font-mono text-sm">{formatMannaExact(manna?.balance)}</dd>
            </div>
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
                Subscription
              </dt>
              <dd className="mt-1 font-mono text-sm">
                {formatMannaExact(manna?.subscriptionBalance)}
              </dd>
            </div>
          </div>
        </dl>
        <div className="mt-6 border-t border-edge pt-5">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">
            Subscription
          </h3>
          {subscription ? (
            <dl className="mt-3 grid gap-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted">Tier</dt>
                <dd className="text-right text-foreground">{labelForTier(subscription.tier)}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted">Status</dt>
                <dd className="text-right text-foreground">{subscription.status}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted">Monthly manna</dt>
                <dd className="text-right font-mono text-foreground">
                  {formatMannaExact(subscription.monthlyManna)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted">Renews</dt>
                <dd className="text-right text-foreground">
                  {subscription.currentPeriodEnd
                    ? formatDate(subscription.currentPeriodEnd)
                    : "—"}
                </dd>
              </div>
              {subscription.cancelAtPeriodEnd ? (
                <div className="rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-xs text-amber-200">
                  Cancellation is scheduled at period end.
                </div>
              ) : null}
            </dl>
          ) : (
            <p className="mt-3 text-sm leading-6 text-muted">
              No active subscription is recorded for this account.
            </p>
          )}
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/manna"
            className="rounded-lg border border-accent/40 px-3.5 py-2 text-sm text-accent-soft transition-colors hover:border-accent hover:text-accent"
          >
            Manage manna
          </Link>
          <Link
            href="/agents"
            className="rounded-lg border border-edge px-3.5 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
          >
            View agents
          </Link>
        </div>
      </section>
    </div>
  );
}

export function SettingsClient() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    setPhase("loading");
    void Promise.all([api.auth.me(), api.billing.subscription()]).then(
      ([auth, subscription]) => {
        if (!alive) return;
        setData({ ...auth, subscription });
        setPhase("ready");
      },
      (err) => {
        if (!alive) return;
        setError(err);
        setPhase("error");
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-14 md:px-10">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
          Account
        </p>
        <h1 className="mt-2 text-3xl font-light tracking-tight md:text-4xl">
          Settings
        </h1>
      </header>

      {phase === "loading" ? (
        <section className="mt-10 rounded-xl border border-edge bg-surface p-6">
          <div className="h-4 w-28 rounded bg-white/[0.08]" />
          <div className="mt-5 h-8 w-56 rounded bg-white/[0.08]" />
          <div className="mt-8 space-y-3">
            <div className="h-4 w-full max-w-md rounded bg-white/[0.06]" />
            <div className="h-4 w-full max-w-sm rounded bg-white/[0.06]" />
          </div>
        </section>
      ) : phase === "error" ? (
        <section className="mt-10 rounded-xl border border-edge bg-surface p-6">
          <h2 className="text-lg font-medium">{errorCopy(error).title}</h2>
          <p className="mt-2 text-sm leading-6 text-muted">{errorCopy(error).hint}</p>
          <button
            type="button"
            onClick={() => {
              setPhase("loading");
              void Promise.all([api.auth.me(), api.billing.subscription()]).then(
                ([auth, subscription]) => {
                  setData({ ...auth, subscription });
                  setPhase("ready");
                },
                (err) => {
                  setError(err);
                  setPhase("error");
                },
              );
            }}
            className="mt-5 rounded-lg border border-edge px-3.5 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
          >
            Retry
          </button>
        </section>
      ) : data ? (
        <SettingsSummary data={data} />
      ) : null}
    </div>
  );
}
