"use client";

import { TasksClient } from "@/app/tasks/tasks-client";
import { useSelectedAgent } from "@/components/shell/selected-agent-context";
import { Skeleton } from "@/components/skeleton";

export function ScheduleClient() {
  const { agent } = useSelectedAgent();
  if (!agent) {
    return (
      <div className="space-y-3" aria-busy>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  return <TasksClient fixedAgent={agent} />;
}
