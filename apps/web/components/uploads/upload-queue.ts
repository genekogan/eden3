import {
  MAX_UPLOAD_BYTES,
  UploadClientError,
  type UploadProgress,
  type UploadPurpose,
  type UploadableFile,
} from "@/lib/resumable-upload";

export type UploadPhase =
  | "queued"
  | "uploading"
  | "paused"
  | "failed"
  | "available";

export interface UploadQueueItem {
  id: string;
  file: UploadableFile;
  purpose: UploadPurpose;
  phase: UploadPhase;
  attempt: number;
  uploadId?: string;
  objectId?: string;
  url?: string;
  uploadedBytes: number;
  partCount: number;
  completedParts: number;
  error?: string;
}

export type UploadQueueAction =
  | { type: "add"; items: UploadQueueItem[] }
  | { type: "start"; id: string; attempt: number }
  | { type: "session"; id: string; attempt: number; uploadId: string; objectId: string }
  | { type: "progress"; id: string; attempt: number; progress: UploadProgress }
  | { type: "pause"; id: string; attempt: number }
  | { type: "resume"; id: string }
  | { type: "fail"; id: string; attempt: number; error: string }
  | { type: "complete"; id: string; attempt: number; objectId: string; url: string }
  | { type: "remove"; id: string };

function updateItem(
  items: UploadQueueItem[],
  id: string,
  update: (item: UploadQueueItem) => UploadQueueItem,
): UploadQueueItem[] {
  return items.map((item) => (item.id === id ? update(item) : item));
}

/** Pure queue transitions, kept separate so pause/resume/retry are deterministic. */
export function uploadQueueReducer(
  items: UploadQueueItem[],
  action: UploadQueueAction,
): UploadQueueItem[] {
  switch (action.type) {
    case "add":
      return [...items, ...action.items];
    case "start":
      return updateItem(items, action.id, (item) =>
        item.phase === "queued"
          ? { ...item, phase: "uploading", attempt: action.attempt, error: undefined }
          : item,
      );
    case "session":
      return updateItem(items, action.id, (item) =>
        item.attempt === action.attempt
          ? { ...item, uploadId: action.uploadId, objectId: action.objectId }
          : item,
      );
    case "progress":
      return updateItem(items, action.id, (item) =>
        item.attempt === action.attempt && item.phase === "uploading"
          ? {
              ...item,
              uploadId: action.progress.uploadId,
              uploadedBytes: action.progress.uploadedBytes,
              completedParts: action.progress.completedParts,
              partCount: action.progress.partCount,
            }
          : item,
      );
    case "pause":
      return updateItem(items, action.id, (item) =>
        item.attempt === action.attempt && item.phase === "uploading"
          ? { ...item, phase: "paused", error: undefined }
          : item,
      );
    case "resume":
      return updateItem(items, action.id, (item) =>
        item.phase === "paused" || item.phase === "failed"
          ? { ...item, phase: "queued", error: undefined }
          : item,
      );
    case "fail":
      return updateItem(items, action.id, (item) =>
        item.attempt === action.attempt && item.phase === "uploading"
          ? { ...item, phase: "failed", error: action.error }
          : item,
      );
    case "complete":
      return updateItem(items, action.id, (item) =>
        item.attempt === action.attempt
          ? {
              ...item,
              phase: "available",
              uploadedBytes: item.file.size,
              objectId: action.objectId,
              url: action.url,
              error: undefined,
            }
          : item,
      );
    case "remove":
      return items.filter((item) => item.id !== action.id || item.phase === "uploading");
  }
}

export function uploadPercent(item: UploadQueueItem): number {
  if (item.phase === "available") return 100;
  if (item.file.size <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((item.uploadedBytes / item.file.size) * 100)));
}

export function formatUploadBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function validateUploadFile(file: UploadableFile): string | null {
  if (file.size <= 0) return "This file is empty.";
  if (file.size > MAX_UPLOAD_BYTES) return "This file is larger than the 64 MiB limit.";
  return null;
}

export function describeUploadFailure(error: unknown): string {
  if (error instanceof UploadClientError) {
    if (error.status === 401) return "Your sign-in expired. Sign in again, then retry.";
    if (error.status === 413 || error.code === "upload_too_large") {
      return "This file is larger than the 64 MiB limit.";
    }
    if (error.code === "resume_file_mismatch") {
      return "This file no longer matches its saved upload. Remove it and choose the original file.";
    }
    if (/quarant|policy|malware|unsafe/i.test(error.code)) {
      return "This file did not pass the safety check and was not made available.";
    }
    if (error.status === 409) return "The upload changed on the server. Retry to reconcile it.";
  }
  return "Upload failed. Your completed parts are saved; retry to continue.";
}

export function isUploadAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}
