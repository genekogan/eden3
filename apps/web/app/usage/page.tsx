import type { Metadata } from "next";
import { UsageClient } from "./usage-client";

export const metadata: Metadata = { title: "Usage" };

export default function UsagePage() {
  return <UsageClient />;
}
