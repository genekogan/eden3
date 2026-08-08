import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UploadQueueList } from "../components/uploads/upload-panel";
import {
  describeUploadFailure,
  uploadQueueReducer,
  validateUploadFile,
  type UploadQueueItem,
} from "../components/uploads/upload-queue";
import { UploadClientError, type UploadableFile } from "../lib/resumable-upload";

function uploadFile(contents: string, name = "notes.txt"): UploadableFile {
  return Object.assign(new Blob([contents], { type: "text/plain" }), { name });
}

function item(overrides: Partial<UploadQueueItem> = {}): UploadQueueItem {
  return {
    id: "item-1",
    file: uploadFile("abcdef"),
    purpose: "chat",
    phase: "queued",
    attempt: 0,
    uploadedBytes: 0,
    completedParts: 0,
    partCount: 0,
    ...overrides,
  };
}

describe("upload queue", () => {
  it("keeps the durable session through pause/resume and ignores stale failures", () => {
    let items = uploadQueueReducer([], { type: "add", items: [item()] });
    items = uploadQueueReducer(items, { type: "start", id: "item-1", attempt: 1 });
    items = uploadQueueReducer(items, {
      type: "session",
      id: "item-1",
      attempt: 1,
      uploadId: "upload-1",
      objectId: "object-1",
    });
    items = uploadQueueReducer(items, {
      type: "progress",
      id: "item-1",
      attempt: 1,
      progress: {
        uploadId: "upload-1",
        fileName: "notes.txt",
        uploadedBytes: 3,
        totalBytes: 6,
        completedParts: 1,
        partCount: 2,
      },
    });
    items = uploadQueueReducer(items, { type: "pause", id: "item-1", attempt: 1 });
    items = uploadQueueReducer(items, { type: "resume", id: "item-1" });
    items = uploadQueueReducer(items, { type: "start", id: "item-1", attempt: 2 });
    items = uploadQueueReducer(items, {
      type: "fail",
      id: "item-1",
      attempt: 1,
      error: "stale abort",
    });

    expect(items[0]).toMatchObject({
      phase: "uploading",
      attempt: 2,
      uploadId: "upload-1",
      uploadedBytes: 3,
    });

    items = uploadQueueReducer(items, {
      type: "complete",
      id: "item-1",
      attempt: 2,
      objectId: "object-1",
      url: "/media/object-1",
    });
    expect(items[0]).toMatchObject({
      phase: "available",
      uploadedBytes: 6,
      url: "/media/object-1",
    });
  });

  it("renders actionable progress, retry, resume, and available states", () => {
    const html = renderToStaticMarkup(
      <UploadQueueList
        items={[
          item({ phase: "uploading", uploadedBytes: 3, completedParts: 1, partCount: 2 }),
          item({ id: "item-2", phase: "paused", uploadId: "upload-2" }),
          item({ id: "item-3", phase: "failed", error: "Upload failed safely." }),
          item({ id: "item-4", phase: "available", url: "/media/object-4" }),
        ]}
      />,
    );

    expect(html).toContain("Uploading · 50%");
    expect(html).toContain("aria-valuenow=\"50\"");
    expect(html).toContain("Pause");
    expect(html).toContain("Resume");
    expect(html).toContain("Retry");
    expect(html).toContain("Upload failed safely.");
    expect(html).toContain("Available");
    expect(html).toContain("href=\"/media/object-4\"");
    expect(html).toContain("Open file");
  });

  it("rejects empty/oversized files and converts server failures to safe guidance", () => {
    expect(validateUploadFile(uploadFile(""))).toBe("This file is empty.");
    const oversized = {
      name: "huge.txt",
      type: "text/plain",
      size: 65 * 1024 * 1024,
    } as UploadableFile;
    expect(validateUploadFile(oversized)).toContain("64 MiB");
    expect(
      describeUploadFailure(new UploadClientError(422, "policy_quarantined", "raw provider detail")),
    ).toBe("This file did not pass the safety check and was not made available.");
    expect(describeUploadFailure(new Error("private network detail"))).not.toContain("private");
  });
});
