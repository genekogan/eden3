"use client";

/**
 * Labeled form primitives shared by the create + edit agent forms.
 * One visual language: quiet labels, raised inputs, violet focus ring.
 */

import type { ReactNode } from "react";

export const inputClass =
  "w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-foreground placeholder:text-faint transition-colors focus:border-accent/60 focus:outline-none disabled:opacity-50";

export function FieldShell({
  id,
  label,
  hint,
  note,
  optional,
  children,
}: {
  id: string;
  label: string;
  /** Muted helper line under the control. */
  hint?: string;
  /** Live status line (validation, availability) — rendered above the hint. */
  note?: ReactNode;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1.5 flex items-baseline gap-2 text-sm text-foreground"
      >
        {label}
        {optional ? (
          <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
            optional
          </span>
        ) : null}
      </label>
      {children}
      {note ? <div className="mt-1.5 text-xs">{note}</div> : null}
      {hint ? (
        <p className="mt-1.5 text-xs leading-relaxed text-faint">{hint}</p>
      ) : null}
    </div>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  onBlur,
  placeholder,
  hint,
  note,
  optional,
  disabled,
  maxLength,
  autoFocus,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  hint?: string;
  note?: ReactNode;
  optional?: boolean;
  disabled?: boolean;
  maxLength?: number;
  autoFocus?: boolean;
}) {
  return (
    <FieldShell id={id} label={label} hint={hint} note={note} optional={optional}>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={maxLength}
        autoFocus={autoFocus}
        className={inputClass}
      />
    </FieldShell>
  );
}

export function TextAreaField({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  note,
  optional,
  disabled,
  rows = 3,
  mono,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  note?: ReactNode;
  optional?: boolean;
  disabled?: boolean;
  rows?: number;
  /** Persona-style prompt text reads better in mono. */
  mono?: boolean;
}) {
  return (
    <FieldShell id={id} label={label} hint={hint} note={note} optional={optional}>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        className={`${inputClass} resize-y leading-relaxed ${mono ? "font-mono text-[13px]" : ""}`}
      />
    </FieldShell>
  );
}

/** Primary (violet) and quiet button styles shared by the forms. */
export const primaryButtonClass =
  "inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/85 disabled:pointer-events-none disabled:opacity-50";

export const quietButtonClass =
  "inline-flex items-center gap-2 rounded-lg border border-edge px-4 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

/** Tiny inline spinner for busy buttons. */
export function ButtonSpinner() {
  return (
    <span
      aria-hidden
      className="size-3.5 animate-spin rounded-full border-[1.5px] border-white/30 border-t-white"
    />
  );
}
