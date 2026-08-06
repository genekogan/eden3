import Link from "next/link";
import { EmptyState } from "@/components/empty-state";

/** Rendered by notFound() for missing or private creations. */
export default function CreationNotFound() {
  return (
    <div className="mx-auto w-full max-w-xl px-6 py-24">
      <EmptyState
        title="This creation doesn't exist — or isn't public"
        hint="The link may be wrong, or the piece may have been removed or made private."
        action={
          <Link
            href="/"
            className="rounded-md border border-edge px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground"
          >
            Back home
          </Link>
        }
      />
    </div>
  );
}
