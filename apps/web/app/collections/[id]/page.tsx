import type { Metadata } from "next";
import { CollectionClient } from "./collection-client";

export const metadata: Metadata = { title: "Collection" };

/** Permalinks accept uuids and legacy 24-hex Mongo ids — passed verbatim. */
export default async function CollectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CollectionClient id={decodeURIComponent(id)} />;
}
