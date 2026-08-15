"use client";

import React, { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { api } from "@/lib/api";
import { loadClerk, selectAuthMode } from "@/lib/clerk";
import type { AgentAvatarUploadInput, DevUser } from "@/lib/types";

const ACCEPTED_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

async function avatarInput(file: File): Promise<AgentAvatarUploadInput> {
  if (!ACCEPTED_MIMES.has(file.type)) {
    throw new Error("Choose a PNG, JPEG, or WebP image.");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error("Profile photos must be 8MB or smaller.");
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read that image."));
    reader.readAsDataURL(file);
  });
  return {
    filename: file.name,
    mime: file.type,
    dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
  };
}

export function AccountAvatarEditor({
  user,
  onChange,
}: {
  user: DevUser;
  onChange: (user: DevUser) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await api.account.uploadAvatar(await avatarInput(file)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The profile photo could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      let user = await api.account.removeAvatar();
      if (selectAuthMode() === "clerk") {
        const identityUrl = (await loadClerk()).user?.imageUrl;
        if (identityUrl) user = await api.account.syncIdentityAvatar(identityUrl);
      }
      onChange(user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The profile photo could not be removed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <AgentAvatar account={user} size={56} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-2xl font-light">@{user.username}</h2>
          <p className="mt-1 text-sm text-muted">
            {user.type ?? "user"} account{user.isAdmin ? " · admin" : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            onChange={(event) => void choose(event)}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="rounded-lg border border-edge px-3 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground disabled:cursor-wait disabled:opacity-60"
          >
            {busy ? "Saving…" : user.userImage ? "Change photo" : "Add photo"}
          </button>
          {user.userImage && !user.userImage.startsWith("https://img.clerk.com/") ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className="rounded-lg border border-edge px-3 py-2 text-sm text-muted transition-colors hover:border-danger-soft/50 hover:text-danger-soft disabled:cursor-wait disabled:opacity-60"
            >
              {selectAuthMode() === "clerk" ? "Use sign-in photo" : "Remove"}
            </button>
          ) : null}
        </div>
      </div>
      <p className="mt-3 text-xs leading-5 text-faint">
        Your Google or other sign-in photo is imported automatically. A photo you choose here takes precedence.
      </p>
      {error ? <p className="mt-2 text-xs text-danger-soft" role="alert">{error}</p> : null}
    </div>
  );
}
