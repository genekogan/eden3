import type { Metadata } from "next";
import { unstable_noStore } from "next/cache";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { MediaFull } from "@/components/media";
import { Markdown } from "@/components/chat/markdown";
import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { PublicSessionShareDto } from "@/lib/types";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const description = "An unlisted conversation shared from Eden.";
const shareMetadata: Metadata = {
  title: "Shared conversation",
  description,
  referrer: "no-referrer",
  robots: { index: false, follow: false, nocache: true },
  openGraph: { title: "Shared conversation", description, type: "article" },
};

type Props = { params: Promise<{ token: string }> };

function loadShare(token: string): Promise<PublicSessionShareDto> {
  unstable_noStore();
  return api.shares.public(token);
}

function decodeToken(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function safeTitle(share: PublicSessionShareDto): string {
  const title = share.share.title ?? share.snapshot.sessionTitle ?? "Shared conversation";
  return title.length > 70 ? `${title.slice(0, 69)}…` : title;
}

/**
 * Resolve revocation before Next starts streaming static metadata. Otherwise a
 * later `notFound()` becomes a soft 200 even though the capability is gone.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  try {
    await loadShare(decodeToken(token));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
  }
  return shareMetadata;
}

export default async function SharedSessionPage({ params }: Props) {
  const { token } = await params;
  let shared: PublicSessionShareDto;
  try {
    shared = await loadShare(decodeToken(token));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    return (
      <main className="mx-auto flex min-h-dvh max-w-xl items-center px-6">
        <EmptyState
          title="This shared conversation can't be loaded right now"
          hint="The API may still be starting. Refresh to try again."
        />
      </main>
    );
  }

  const title = safeTitle(shared);
  const primaryAgent = shared.snapshot.agents[0] ?? null;
  return (
    <main className="mx-auto min-h-dvh w-full max-w-3xl px-4 py-8 md:px-8 md:py-12">
      <header className="border-b border-edge pb-6">
        <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-faint">
          Unlisted Eden conversation
        </p>
        <h1 className="mt-3 text-2xl font-light tracking-tight text-foreground">{title}</h1>
        <p className="mt-2 text-xs text-muted">
          {primaryAgent ? `with ${primaryAgent.name ?? `@${primaryAgent.username}`} · ` : ""}
          {shared.share.mode === "snapshot"
            ? `Snapshot captured ${formatDateTime(shared.snapshot.capturedAt)}`
            : "Live share — new saved messages may appear"}
        </p>
      </header>

      <section aria-label="Shared transcript" className="space-y-6 py-8">
        {shared.snapshot.messages.map((message) => (
          <article
            key={message.id}
            data-role={message.role}
            className={
              message.role === "user"
                ? "ml-auto max-w-[85%] rounded-2xl rounded-br-md border border-accent/20 bg-accent/[0.13] px-4 py-3 sm:max-w-[72%]"
                : message.role === "system"
                  ? "mx-auto max-w-lg rounded-full border border-edge px-4 py-2 text-center text-xs text-faint"
                  : "max-w-[92%]"
            }
          >
            {message.role === "assistant" ? (
              <p className="mb-1.5 text-xs font-medium text-muted">
                {message.name ?? primaryAgent?.name ?? primaryAgent?.username ?? "Agent"}
              </p>
            ) : null}
            {message.content ? (
              message.role === "assistant" ? (
                <Markdown text={message.content} />
              ) : (
                <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">
                  {message.content}
                </p>
              )
            ) : null}
            {message.attachments.length > 0 ? (
              <div className="mt-3 space-y-3">
                {message.attachments.map((attachment, index) => (
                  <MediaFull
                    key={`${message.id}:${attachment.url}:${index}`}
                    url={attachment.url}
                    mime={attachment.mime}
                    alt="Shared attachment"
                    className="max-w-full"
                  />
                ))}
              </div>
            ) : null}
          </article>
        ))}
        {shared.snapshot.messages.length === 0 ? (
          <EmptyState title="No messages in this shared excerpt" />
        ) : null}
      </section>

      <footer className="border-t border-edge pt-5 text-center text-[11px] text-faint">
        This link is unlisted and can be revoked by a session member.
      </footer>
    </main>
  );
}
