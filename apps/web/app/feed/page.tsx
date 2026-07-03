import { redirect } from "next/navigation";

/**
 * Legacy route name: the surface lives at /explore. Preserve the query so
 * scoped links (?agent= / ?user=) keep working.
 */
export default async function FeedRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const values = Array.isArray(value) ? value : value !== undefined ? [value] : [];
    for (const item of values) search.append(key, item);
  }
  const qs = search.toString();
  redirect(`/explore${qs ? `?${qs}` : ""}`);
}
