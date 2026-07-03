"use client";

/**
 * Tool picker — one quiet card per studio tool (image / video / music /
 * speech), each carrying its manna price and a latency hint. Selection is a
 * radiogroup; the active card gets the violet treatment.
 */

import type { StudioTool } from "@/lib/types";
import {
  categorizeTool,
  latencyHint,
  toolLabel,
  type StudioCategory,
} from "./catalog";
import { MannaAmount } from "./manna-amount";

/** Line icon per category — same stroke language as the manna glyph. */
export function ToolIcon({
  category,
  className,
}: {
  category: StudioCategory;
  className?: string;
}) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: className ?? "size-5",
  };
  switch (category) {
    case "image":
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <circle cx="8.5" cy="10" r="1.5" />
          <path d="m21 15-4.5-4.5L9 18" />
        </svg>
      );
    case "video":
      return (
        <svg {...common}>
          <rect x="2" y="6" width="14" height="12" rx="2" />
          <path d="m22 8-6 4 6 4z" />
        </svg>
      );
    case "music":
      return (
        <svg {...common}>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      );
    case "speech":
      return (
        <svg {...common}>
          <path d="M11 5 6 9H2v6h4l5 4z" />
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.8 5.8a9 9 0 0 1 0 12.4" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
        </svg>
      );
  }
}

export function ToolPicker({
  tools,
  selectedName,
  onSelect,
  disabled = false,
}: {
  tools: StudioTool[];
  selectedName: string | null;
  onSelect: (name: string) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Generation tool"
      className="grid grid-cols-2 gap-3 sm:grid-cols-4"
    >
      {tools.map((tool) => {
        const category = categorizeTool(tool);
        const active = tool.name === selectedName;
        return (
          <button
            key={tool.name}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onSelect(tool.name)}
            title={
              typeof tool.description === "string" && tool.description
                ? tool.description
                : undefined
            }
            className={`flex flex-col items-start gap-3 rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              active
                ? "border-accent/60 bg-accent/[0.07]"
                : "border-edge bg-surface hover:border-accent/30 hover:bg-raised"
            }`}
          >
            <ToolIcon
              category={category}
              className={`size-5 shrink-0 ${active ? "text-accent-soft" : "text-faint"}`}
            />
            <span className="min-w-0">
              <span
                className={`block text-sm font-medium ${active ? "text-foreground" : "text-muted"}`}
              >
                {toolLabel(tool)}
              </span>
              <span className="mt-0.5 block text-[11px] text-faint">
                {latencyHint(category)}
              </span>
            </span>
            <MannaAmount
              amount={typeof tool.costManna === "number" ? tool.costManna : null}
              className={active ? "text-accent-soft" : "text-faint"}
            />
          </button>
        );
      })}
    </div>
  );
}
