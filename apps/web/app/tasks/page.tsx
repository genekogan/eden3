import { redirectToAgentSub } from "@/lib/last-agent-server";

/** Legacy /tasks — scheduling lives with each agent now (Schedule). */
export default async function LegacyTasksPage() {
  await redirectToAgentSub("schedule");
}
