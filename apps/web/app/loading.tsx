/** Root loading state (only `/` — an instant redirect — uses it): one quiet pulse. */
export default function RootLoading() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <span
        aria-hidden
        className="size-2.5 animate-pulse rounded-full bg-accent"
      />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
