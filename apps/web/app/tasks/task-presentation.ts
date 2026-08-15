import type { TaskRunHistoryItemDto } from "@/lib/types";

export interface FriendlyTaskIssue {
  kind: "budget" | "missed" | "failure";
  title: string;
  detail: string;
  spent?: number;
  requested?: number;
  cap?: number;
}

/**
 * Translate scheduler internals into useful, non-sensitive owner copy.
 * Never echo raw exception text: it can contain database ids and implementation
 * details which belong in operator logs, not the product UI.
 */
export function friendlyTaskIssue(raw: string | null | undefined): FriendlyTaskIssue | null {
  if (!raw) return null;
  const rolling = /automation rolling manna cap exceeded:[\s\S]*?spent (\d+)[\s\S]*?requested (\d+) more, cap is (\d+)/i.exec(raw);
  const alreadyAtCap = /automation hourly manna cap reached:\s*(\d+) spent[\s\S]*?cap is (\d+)/i.exec(raw);
  if (rolling) {
    const spent = Number(rolling[1]);
    const requested = Number(rolling[2]);
    const cap = Number(rolling[3]);
    return {
      kind: "budget",
      title: "Paused to protect your manna",
      detail: `This agent used ${spent} of its ${cap}-manna automation allowance in the past hour. The next run needed to reserve up to ${requested} more, so Eden paused it instead of repeatedly retrying. The allowance returns gradually as earlier runs age past one hour.`,
      spent,
      requested,
      cap,
    };
  }
  if (alreadyAtCap) {
    const spent = Number(alreadyAtCap[1]);
    const cap = Number(alreadyAtCap[2]);
    return {
      kind: "budget",
      title: "Paused to protect your manna",
      detail: `This agent used ${spent} of its ${cap}-manna automation allowance in the past hour. Eden paused the task instead of repeatedly retrying. The allowance returns gradually as earlier runs age past one hour.`,
      spent,
      cap,
    };
  }
  if (/missed run|misfire|overdue/i.test(raw)) {
    return {
      kind: "missed",
      title: "A scheduled run was missed",
      detail: "Eden could not start this run at its scheduled time. Review the latest output, then resume the task when you are ready.",
    };
  }
  return {
    kind: "failure",
    title: "The latest run did not complete",
    detail: "Open the latest run’s conversation for details, then retry or edit the task.",
  };
}

export function runStatusLabel(run: TaskRunHistoryItemDto): string {
  if (run.errorCode || /error|failed/i.test(run.status)) return "Failed";
  if (/completed|success/i.test(run.status)) return "Completed";
  return run.status.replaceAll("_", " ");
}
