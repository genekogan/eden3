"use client";

/**
 * Client error boundary. Wraps the app shell's content column (and can wrap
 * any risky subtree) so one broken surface degrades to a quiet card instead
 * of a white screen. "Try again" resets the boundary and re-renders.
 */

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Override the default fallback card. */
  fallback?: ReactNode;
  /** Short label for what broke, e.g. "the feed" (default: "this view"). */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[eden3/web] boundary caught:", error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <div className="mx-auto w-full max-w-xl px-6 py-16">
        <div className="flex flex-col items-center rounded-xl border border-dashed border-edge px-6 py-12 text-center">
          <p className="text-sm text-muted">
            Something went wrong rendering {this.props.label ?? "this view"}.
          </p>
          <p className="mt-1.5 max-w-sm break-words font-mono text-xs leading-relaxed text-faint">
            {error.message}
          </p>
          <button
            type="button"
            onClick={this.reset}
            className="mt-5 rounded-md border border-edge px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/50 hover:text-foreground"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
