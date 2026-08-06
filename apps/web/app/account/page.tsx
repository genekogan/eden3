import type { Metadata } from "next";
import { SettingsClient } from "./account-client";

export const metadata: Metadata = { title: "Account" };

/** /account — USER settings: profile, billing/subscription, data export. */
export default function AccountPage() {
  return <SettingsClient />;
}
