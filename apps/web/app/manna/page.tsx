import type { Metadata } from "next";
import { MannaClient } from "./manna-client";

export const metadata: Metadata = { title: "Manna" };

export default function MannaPage() {
  return <MannaClient />;
}
