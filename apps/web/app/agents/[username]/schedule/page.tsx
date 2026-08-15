import type { Metadata } from "next";
import { ScheduleClient } from "./schedule-client";

export const metadata: Metadata = { title: "Schedules" };

/**
 * /agents/[username]/schedule — the agent's recurring tasks and routines:
 * active (green), paused (gray), running (pulsing), with run-now / pause /
 * edit / delete inline.
 */
export default function AgentSchedulePage() {
  return <ScheduleClient />;
}
