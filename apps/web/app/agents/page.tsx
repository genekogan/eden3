import type { Metadata } from "next";
import { AgentsDirectory } from "@/components/agents/agents-directory";

export const metadata: Metadata = {
  title: "Agents",
  description: "Browse Eden's creative agents — or create your own.",
};

export default function AgentsPage() {
  return <AgentsDirectory />;
}
