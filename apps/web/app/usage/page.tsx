import { redirectToAgentSub } from "@/lib/last-agent-server";

/** Legacy /usage — now the agent-scoped Log. */
export default async function LegacyUsagePage() {
  await redirectToAgentSub("log");
}
