import type { Metadata } from "next";
import { MannaClient } from "./manna-client";

export const metadata: Metadata = { title: "Manna" };

/** /account/manna — balance, ledger, top-ups (user-level). */
export default function AccountMannaPage() {
  return <MannaClient />;
}
