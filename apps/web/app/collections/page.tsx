import type { Metadata } from "next";
import { CollectionsClient } from "./collections-client";

export const metadata: Metadata = { title: "Collections" };

export default function CollectionsPage() {
  return <CollectionsClient />;
}
