"use client";

import React, {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { getClerkToken } from "@/lib/clerk";
import {
  ResumableUploader,
  type UploadPurpose,
  type UploadableFile,
} from "@/lib/resumable-upload";
import {
  describeUploadFailure,
  formatUploadBytes,
  isUploadAbort,
  uploadPercent,
  uploadQueueReducer,
  validateUploadFile,
  type UploadQueueItem,
} from "./upload-queue";

type UploadRunner = Pick<ResumableUploader, "uploadFile">;

function UploadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-5"
      aria-hidden
    >
      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" />
      <path d="M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" />
    </svg>
  );
}

function statusLabel(item: UploadQueueItem): string {
  switch (item.phase) {
    case "queued":
      return "Waiting";
    case "uploading":
      return item.uploadedBytes > 0 ? `Uploading · ${uploadPercent(item)}%` : "Preparing…";
    case "paused":
      return `Paused · ${uploadPercent(item)}%`;
    case "failed":
      return "Needs attention";
    case "available":
      return "Available";
  }
}

export function UploadQueueList({
  items,
  onPause = () => undefined,
  onResume = () => undefined,
  onRemove = () => undefined,
}: {
  items: UploadQueueItem[];
  onPause?: (item: UploadQueueItem) => void;
  onResume?: (item: UploadQueueItem) => void;
  onRemove?: (item: UploadQueueItem) => void;
}) {
  if (items.length === 0) return null;

  return (
    <ul className="mt-4 space-y-2" aria-label="Upload queue">
      {items.map((item) => {
        const percent = uploadPercent(item);
        return (
          <li key={item.id} className="rounded-xl border border-edge bg-background/50 p-3">
            <div className="flex min-w-0 items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="truncate text-sm text-foreground" title={item.file.name}>
                    {item.file.name}
                  </p>
                  <span
                    className={`shrink-0 text-xs ${
                      item.phase === "failed"
                        ? "text-danger-soft"
                        : item.phase === "available"
                          ? "text-success-soft"
                          : "text-muted"
                    }`}
                  >
                    {statusLabel(item)}
                  </span>
                </div>

                <div
                  role="progressbar"
                  aria-label={`${item.file.name} upload progress`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-edge"
                >
                  <div
                    className={`h-full rounded-full transition-[width] ${
                      item.phase === "failed" ? "bg-danger" : "bg-accent"
                    }`}
                    style={{ width: `${percent}%` }}
                  />
                </div>

                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] text-faint">
                    {formatUploadBytes(item.uploadedBytes)} of {formatUploadBytes(item.file.size)}
                    {item.partCount > 0
                      ? ` · ${item.completedParts}/${item.partCount} parts`
                      : ""}
                  </p>
                  <div className="flex items-center gap-3 text-xs">
                    {item.phase === "uploading" ? (
                      <button
                        type="button"
                        onClick={() => onPause(item)}
                        className="text-muted transition-colors hover:text-foreground"
                      >
                        Pause
                      </button>
                    ) : null}
                    {item.phase === "paused" || item.phase === "failed" ? (
                      <button
                        type="button"
                        onClick={() => onResume(item)}
                        className="text-accent-soft transition-colors hover:text-accent"
                      >
                        {item.phase === "failed" ? "Retry" : "Resume"}
                      </button>
                    ) : null}
                    {item.phase === "available" && item.url ? (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent-soft transition-colors hover:text-accent"
                      >
                        Open file
                      </a>
                    ) : null}
                    {item.phase !== "uploading" ? (
                      <button
                        type="button"
                        onClick={() => onRemove(item)}
                        className="text-faint transition-colors hover:text-foreground"
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                </div>
                {item.error ? (
                  <p role="alert" className="mt-2 text-xs text-danger-soft">
                    {item.error}
                  </p>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function UploadPanel({ uploader: providedUploader }: { uploader?: UploadRunner } = {}) {
  const defaultUploader = useMemo(
    () =>
      new ResumableUploader({
        apiBaseUrl: "/api",
        getAuthToken: getClerkToken,
        refreshCredentials: async () => {
          await getClerkToken();
        },
      }),
    [],
  );
  const uploader = providedUploader ?? defaultUploader;
  const [items, dispatch] = useReducer(uploadQueueReducer, []);
  const [purpose, setPurpose] = useState<UploadPurpose>("chat");
  const [dragging, setDragging] = useState(false);
  const [pumpVersion, setPumpVersion] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const active = useRef<{
    id: string;
    attempt: number;
    controller: AbortController;
  } | null>(null);

  useEffect(() => {
    if (active.current) return;
    const next = items.find((item) => item.phase === "queued");
    if (!next) return;

    const attempt = next.attempt + 1;
    const controller = new AbortController();
    active.current = { id: next.id, attempt, controller };
    dispatch({ type: "start", id: next.id, attempt });

    void uploader
      .uploadFile(next.file, {
        purpose: next.purpose,
        uploadId: next.uploadId,
        signal: controller.signal,
        onSession: ({ uploadId, objectId }) => {
          dispatch({ type: "session", id: next.id, attempt, uploadId, objectId });
        },
        onProgress: (progress) => {
          dispatch({ type: "progress", id: next.id, attempt, progress });
        },
      })
      .then(({ objectId, url }) => {
        dispatch({ type: "complete", id: next.id, attempt, objectId, url });
      })
      .catch((error: unknown) => {
        if (isUploadAbort(error)) {
          dispatch({ type: "pause", id: next.id, attempt });
          return;
        }
        dispatch({
          type: "fail",
          id: next.id,
          attempt,
          error: describeUploadFailure(error),
        });
      })
      .finally(() => {
        if (active.current?.id === next.id && active.current.attempt === attempt) {
          active.current = null;
        }
        setPumpVersion((value) => value + 1);
      });
  }, [items, pumpVersion, uploader]);

  useEffect(
    () => () => {
      active.current?.controller.abort();
    },
  );

  const addFiles = (files: FileList | File[]) => {
    const added = Array.from(files).map((file) => {
      sequence.current += 1;
      const validationError = validateUploadFile(file);
      return {
        id: `${Date.now()}-${sequence.current}`,
        file,
        purpose,
        phase: validationError ? ("failed" as const) : ("queued" as const),
        attempt: 0,
        uploadedBytes: 0,
        completedParts: 0,
        partCount: 0,
        ...(validationError ? { error: validationError } : {}),
      } satisfies UploadQueueItem;
    });
    if (added.length > 0) dispatch({ type: "add", items: added });
  };

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) addFiles(event.target.files);
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
  };

  const pause = (item: UploadQueueItem) => {
    const current = active.current;
    if (!current || current.id !== item.id) return;
    dispatch({ type: "pause", id: item.id, attempt: current.attempt });
    current.controller.abort();
  };

  return (
    <section aria-labelledby="upload-heading" className="rounded-2xl border border-edge bg-surface p-4 sm:p-5">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h2 id="upload-heading" className="text-base font-medium text-foreground">
            Upload files
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
            Files upload privately in resumable parts. Completed files are available immediately.
          </p>
        </div>
        <label className="shrink-0 text-xs text-muted">
          Use as
          <select
            value={purpose}
            onChange={(event) => setPurpose(event.target.value as UploadPurpose)}
            className="ml-2 rounded-lg border border-edge bg-raised px-2.5 py-2 text-sm text-foreground"
          >
            <option value="chat">General file</option>
            <option value="skill-asset">Skill asset</option>
          </select>
        </label>
      </div>

      <div
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={onDrop}
        className={`mt-4 rounded-xl border border-dashed px-4 py-6 text-center transition-colors ${
          dragging
            ? "border-accent bg-accent/[0.08]"
            : "border-edge bg-raised/50 hover:border-accent/50"
        }`}
      >
        <div className="mx-auto flex size-9 items-center justify-center rounded-full bg-accent/10 text-accent-soft">
          <UploadIcon />
        </div>
        <p className="mt-3 text-sm text-foreground">Drop files here</p>
        <p className="mt-1 text-xs text-muted">Multiple files supported · 64 MiB each</p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-4 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-soft"
        >
          Choose files
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          onChange={onInput}
          className="sr-only"
          aria-label="Choose files to upload"
        />
      </div>

      <UploadQueueList
        items={items}
        onPause={pause}
        onResume={(item) => dispatch({ type: "resume", id: item.id })}
        onRemove={(item) => dispatch({ type: "remove", id: item.id })}
      />
    </section>
  );
}
