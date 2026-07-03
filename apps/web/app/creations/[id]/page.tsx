import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AgentAvatar } from "@/components/agent-avatar";
import { EmptyState } from "@/components/empty-state";
import { MediaFull } from "@/components/media";
import {
  argsOf,
  isVideoCreation,
  promptOf,
  sessionRefOf,
} from "@/components/feed/creation-fields";
import { api, ApiError, isApiUnavailable } from "@/lib/api";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import type { AccountSummary, CreationDto } from "@/lib/types";

/**
 * /creations/:id — the permalink. Server-rendered (share links get real
 * metadata); id may be the uuid or the legacy 24-hex Mongo id, passed
 * through verbatim. Media is the hero; everything else is a placard.
 */

const BUTTON =
  "rounded-md border border-edge px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground";

/** One fetch shared by generateMetadata and the page render. */
const loadCreation = cache((id: string): Promise<CreationDto> => {
  return api.creations.get(id);
});

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  try {
    const creation = await loadCreation(decodeId(id));
    const prompt = promptOf(creation);
    const title = prompt
      ? prompt.length > 64
        ? `${prompt.slice(0, 63)}…`
        : prompt
      : "Creation";
    const image =
      creation.thumbnailUrl ??
      (!isVideoCreation(creation) ? creation.url : null);
    return {
      title,
      ...(image ? { openGraph: { title, images: [image] } } : {}),
    };
  } catch {
    return { title: "Creation" };
  }
}

function PersonRow({
  label,
  href,
  account,
}: {
  label: string;
  href: string;
  account: AccountSummary;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-xs text-faint">{label}</dt>
      <dd className="min-w-0">
        <Link
          href={href}
          className="flex items-center gap-2 text-sm text-foreground transition-colors hover:text-accent-soft"
        >
          <AgentAvatar account={account} size={22} />
          <span className="truncate">@{account.username}</span>
        </Link>
      </dd>
    </div>
  );
}

export default async function CreationPage({ params }: Props) {
  const { id } = await params;
  const decoded = decodeId(id);

  let creation: CreationDto | null = null;
  let failure: unknown = null;
  try {
    creation = await loadCreation(decoded);
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 403 || error.status === 404 || error.status === 410)
    ) {
      notFound();
    }
    failure = error;
  }

  if (!creation) {
    // Api down or still landing (501) — degrade quietly, keep the permalink.
    return (
      <div className="mx-auto w-full max-w-xl px-6 py-24">
        <EmptyState
          title="This creation can't be loaded right now"
          hint={
            isApiUnavailable(failure)
              ? "The api isn't reachable — it may still be starting. The link stays good."
              : failure instanceof Error
                ? failure.message
                : "Something unexpected went wrong."
          }
          action={
            // Plain anchor: re-navigating the same URL retries the fetch.
            <a href={`/creations/${encodeURIComponent(decoded)}`} className={BUTTON}>
              Try again
            </a>
          }
        />
      </div>
    );
  }

  const prompt = promptOf(creation);
  const args = argsOf(creation);
  const sessionRef = sessionRefOf(creation);
  const agent = creation.agent ?? null;
  const creator = creation.creator ?? null;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8 md:py-10">
      <Link
        href="/explore"
        className="text-xs text-muted transition-colors hover:text-foreground"
      >
        ← Explore
      </Link>

      <div className="mt-5 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-10">
        <MediaFull
          creation={creation}
          alt={prompt ?? undefined}
          className="w-full"
        />

        <aside className="space-y-5 lg:sticky lg:top-8">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
              {creation.tool ?? "creation"}
            </p>
            <h1 className="mt-2 line-clamp-4 text-lg font-light leading-snug">
              {prompt ?? "Untitled"}
            </h1>
            <p className="mt-2 text-xs text-faint">
              <time dateTime={creation.createdAt}>
                {formatDateTime(creation.createdAt)}
              </time>
              {" · "}
              {formatRelativeTime(creation.createdAt)}
            </p>
          </div>

          {agent || creator ? (
            <dl className="space-y-2.5 border-t border-edge pt-5">
              {agent ? (
                <PersonRow
                  label="Agent"
                  href={`/agents/${encodeURIComponent(agent.username)}`}
                  account={agent}
                />
              ) : null}
              {creator ? (
                <PersonRow
                  label="Creator"
                  href={`/explore?user=${encodeURIComponent(creator.username)}`}
                  account={creator}
                />
              ) : null}
            </dl>
          ) : null}

          {creation.likeCount > 0 ? (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
                className="size-3.5"
              >
                <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z" />
              </svg>
              {creation.likeCount} {creation.likeCount === 1 ? "like" : "likes"}
            </p>
          ) : null}

          {args ? (
            <details className="group rounded-lg border border-edge">
              <summary className="flex cursor-pointer select-none items-center justify-between px-3.5 py-2.5 text-xs text-muted transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                Generation args
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                  className="size-3.5 transition-transform group-open:rotate-90"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </summary>
              <pre className="overflow-x-auto border-t border-edge px-3.5 py-3 font-mono text-[11px] leading-relaxed text-muted">
                {JSON.stringify(args, null, 2)}
              </pre>
            </details>
          ) : null}

          {sessionRef ? (
            <Link
              href={`/sessions/${encodeURIComponent(sessionRef)}`}
              className="flex items-center justify-between gap-3 rounded-lg border border-edge px-3.5 py-2.5 text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground"
            >
              Made in a session — view the conversation
              <span aria-hidden>→</span>
            </Link>
          ) : null}

          <p className="break-all font-mono text-[10px] leading-relaxed text-faint">
            {creation.id}
            {creation.externalId ? ` · ${creation.externalId}` : ""}
          </p>
        </aside>
      </div>
    </div>
  );
}
