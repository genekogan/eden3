import type { SessionShareMode, SessionShareSummaryDto } from "@/lib/types";

export interface SessionShareDialogState {
  open: boolean;
  mode: SessionShareMode;
  title: string;
  items: SessionShareSummaryDto[];
  publicUrl: string | null;
  pending: "load" | "create" | "revoke" | null;
  error: string | null;
}

export const initialSessionShareDialogState: SessionShareDialogState = {
  open: false,
  mode: "snapshot",
  title: "",
  items: [],
  publicUrl: null,
  pending: null,
  error: null,
};

export type SessionShareDialogEvent =
  | { type: "open" }
  | { type: "close" }
  | { type: "mode"; mode: SessionShareMode }
  | { type: "title"; title: string }
  | { type: "load/start" }
  | { type: "load/success"; items: SessionShareSummaryDto[] }
  | { type: "create/start" }
  | { type: "create/success"; share: SessionShareSummaryDto; publicUrl: string }
  | { type: "revoke/start" }
  | { type: "revoke/success"; share: SessionShareSummaryDto }
  | { type: "failure"; message: string };

export function sessionShareDialogReducer(
  state: SessionShareDialogState,
  event: SessionShareDialogEvent,
): SessionShareDialogState {
  switch (event.type) {
    case "open":
      return { ...state, open: true, error: null };
    case "close":
      return { ...state, open: false, pending: null, error: null };
    case "mode":
      return { ...state, mode: event.mode, publicUrl: null };
    case "title":
      return { ...state, title: event.title, publicUrl: null };
    case "load/start":
      return { ...state, pending: "load", error: null };
    case "load/success":
      return { ...state, pending: null, items: event.items };
    case "create/start":
      return { ...state, pending: "create", publicUrl: null, error: null };
    case "create/success":
      return {
        ...state,
        pending: null,
        publicUrl: event.publicUrl,
        items: [event.share, ...state.items.filter((item) => item.id !== event.share.id)],
      };
    case "revoke/start":
      return { ...state, pending: "revoke", error: null };
    case "revoke/success":
      return {
        ...state,
        pending: null,
        publicUrl: null,
        items: state.items.map((item) => (item.id === event.share.id ? event.share : item)),
      };
    case "failure":
      return { ...state, pending: null, error: event.message };
  }
}

export function absoluteShareUrl(publicPath: string, origin: string): string {
  return new URL(publicPath, origin).toString();
}
