"use client";

/**
 * Concepts tab on /agents/[username] — per-agent reference-image aesthetics.
 *
 * Card grid (cover = first reference image) for every viewer of the agent;
 * create / edit / delete / image upload+reorder are owner-only. Selecting a
 * card expands an inline detail panel (collections-style, no modal). The api
 * projects every mutation into the agent's workspace, so a concept is usable
 * in chat ("make something in the style of X") as soon as it's saved here.
 */

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, FormEvent } from "react";
import { api } from "@/lib/api";
import type { ConceptDto, ConceptImageUploadInput } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { describeApiFailure } from "@/components/agents/agent-utils";
import {
  primaryButtonClass,
  quietButtonClass,
} from "@/components/agents/form-fields";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 8;
const ACCEPTED_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Client-side pre-check mirroring the api's upload validation. */
export function conceptImageFileError(file: {
  type: string;
  size: number;
}): string | null {
  if (!ACCEPTED_MIMES.has(file.type)) {
    return "Only png, jpeg, or webp images are supported.";
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return "Images must be 8MB or smaller.";
  }
  return null;
}

/** Read a File into the base64-JSON upload shape shared by concepts + avatars. */
export async function fileToUpload(file: File): Promise<ConceptImageUploadInput> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read file"));
    reader.readAsDataURL(file);
  });
  return {
    filename: file.name,
    mime: file.type,
    dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
  };
}

const inputClass =
  "w-full rounded-lg border border-edge bg-background px-3 py-2 text-sm placeholder:text-faint focus:border-accent/60 focus:outline-none";
const textareaClass = `${inputClass} min-h-[88px] resize-y leading-relaxed`;
const microLabelClass =
  "font-mono text-[11px] uppercase tracking-[0.25em] text-faint";

function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div aria-hidden className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-xl border border-edge/60">
          <Skeleton className="aspect-[4/3] rounded-none" />
          <div className="space-y-2 p-4">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ConceptCover({ concept }: { concept: ConceptDto }) {
  const cover = concept.images[0];
  if (cover) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={cover.url}
        alt={concept.name}
        loading="lazy"
        className="h-full w-full object-cover"
      />
    );
  }
  return (
    <div className="flex h-full w-full items-center justify-center bg-raised">
      <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-faint">
        no references yet
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail / edit panel
// ---------------------------------------------------------------------------

function ConceptDetail({
  username,
  concept,
  canManage,
  onChanged,
  onDeleted,
}: {
  username: string;
  concept: ConceptDto;
  canManage: boolean;
  onChanged: (concept: ConceptDto) => void;
  onDeleted: (slug: string) => void;
}) {
  const [name, setName] = useState(concept.name);
  const [description, setDescription] = useState(concept.description ?? "");
  const [instructions, setInstructions] = useState(concept.instructions ?? "");
  const [busy, setBusy] = useState<"save" | "upload" | "delete" | "image" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Re-seed the form when another card is selected.
  useEffect(() => {
    setName(concept.name);
    setDescription(concept.description ?? "");
    setInstructions(concept.instructions ?? "");
    setNote(null);
    setConfirmDelete(false);
  }, [concept.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy("save");
    setNote(null);
    try {
      const updated = await api.concepts.update(username, concept.slug, {
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
      });
      onChanged(updated);
      setNote("Saved — the agent sees this on its next generation.");
    } catch (error) {
      setNote(describeApiFailure(error));
    } finally {
      setBusy(null);
    }
  };

  // Shared upload path fed by BOTH the file input and drag-and-drop.
  const uploadFiles = async (files: File[]) => {
    if (files.length === 0 || busy) return;
    const room = MAX_IMAGES - concept.images.length;
    if (room <= 0) {
      setNote(`This concept already has ${MAX_IMAGES} reference images.`);
      return;
    }
    setBusy("upload");
    setNote(null);
    try {
      for (const file of files.slice(0, room)) {
        const problem = conceptImageFileError(file);
        if (problem) {
          setNote(`${file.name}: ${problem}`);
          continue;
        }
        onChanged(
          await api.concepts.uploadImage(username, concept.slug, await fileToUpload(file)),
        );
      }
      if (files.length > room) {
        setNote(`Only ${room} more image${room === 1 ? "" : "s"} fit — the limit is ${MAX_IMAGES}.`);
      }
    } catch (error) {
      setNote(describeApiFailure(error));
    } finally {
      setBusy(null);
    }
  };

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    void uploadFiles(files);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    if (!canManage || busy) return;
    void uploadFiles([...event.dataTransfer.files]);
  };

  const moveImage = async (index: number, delta: -1 | 1) => {
    if (busy) return;
    const target = index + delta;
    if (target < 0 || target >= concept.images.length) return;
    const order = concept.images.map((image) => image.id);
    [order[index], order[target]] = [order[target]!, order[index]!];
    setBusy("image");
    setNote(null);
    try {
      onChanged(await api.concepts.reorderImages(username, concept.slug, order));
    } catch (error) {
      setNote(describeApiFailure(error));
    } finally {
      setBusy(null);
    }
  };

  const removeImage = async (imageId: string) => {
    if (busy) return;
    setBusy("image");
    setNote(null);
    try {
      onChanged(await api.concepts.removeImage(username, concept.slug, imageId));
    } catch (error) {
      setNote(describeApiFailure(error));
    } finally {
      setBusy(null);
    }
  };

  const deleteConcept = async () => {
    if (busy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy("delete");
    setNote(null);
    try {
      await api.concepts.remove(username, concept.slug);
      onDeleted(concept.slug);
    } catch (error) {
      setNote(describeApiFailure(error));
      setBusy(null);
      setConfirmDelete(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-edge bg-surface p-5">
      {note ? (
        <p className="mb-4 rounded-lg border border-accent/25 bg-accent/10 px-3 py-2 text-xs text-accent-soft">
          {note}
        </p>
      ) : null}

      {/* Reference images */}
      <h3 className={microLabelClass}>Reference images</h3>
      {concept.images.length === 0 ? (
        <p className="mt-3 text-sm text-faint">
          No reference images yet
          {canManage ? " — add a few below to define the look." : "."}
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {concept.images.map((image, index) => (
            <figure
              key={image.id}
              className="overflow-hidden rounded-lg border border-edge bg-raised"
            >
              <div className="aspect-square">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.url}
                  alt={image.filename ?? `Reference ${index + 1}`}
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              </div>
              {canManage ? (
                <figcaption className="flex items-center justify-between gap-1 px-2 py-1.5">
                  <span className="truncate font-mono text-[10px] text-faint">
                    {index + 1}. {image.filename ?? "reference"}
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      aria-label="Move image up"
                      disabled={busy !== null || index === 0}
                      onClick={() => void moveImage(index, -1)}
                      className="rounded border border-edge px-1.5 text-xs text-muted transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label="Move image down"
                      disabled={busy !== null || index === concept.images.length - 1}
                      onClick={() => void moveImage(index, 1)}
                      className="rounded border border-edge px-1.5 text-xs text-muted transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label="Remove image"
                      disabled={busy !== null}
                      onClick={() => void removeImage(image.id)}
                      className="rounded border border-rose-400/30 px-1.5 text-xs text-rose-300 transition-colors hover:border-rose-400/60 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      ×
                    </button>
                  </span>
                </figcaption>
              ) : null}
            </figure>
          ))}
        </div>
      )}
      {canManage ? (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            if (!dragOver) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={`mt-3 rounded-lg border border-dashed p-3 text-center transition-colors ${
            dragOver ? "border-accent/60 bg-accent/5" : "border-edge"
          }`}
        >
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={onInputChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy !== null || concept.images.length >= MAX_IMAGES}
            className={quietButtonClass}
          >
            {busy === "upload"
              ? "Uploading…"
              : `Add images (${concept.images.length}/${MAX_IMAGES})`}
          </button>
          <p className="mt-1.5 text-[11px] text-faint">or drop images here</p>
        </div>
      ) : null}

      {/* Text fields */}
      {canManage ? (
        <form onSubmit={(event) => void save(event)} className="mt-6 space-y-4">
          <div>
            <label htmlFor={`concept-name-${concept.id}`} className={microLabelClass}>
              Name
            </label>
            <input
              id={`concept-name-${concept.id}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              className={`mt-2 ${inputClass}`}
            />
          </div>
          <div>
            <label
              htmlFor={`concept-description-${concept.id}`}
              className={microLabelClass}
            >
              Description
            </label>
            <input
              id={`concept-description-${concept.id}`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={2000}
              placeholder="One line on what this aesthetic looks like"
              className={`mt-2 ${inputClass}`}
            />
          </div>
          <div>
            <label
              htmlFor={`concept-instructions-${concept.id}`}
              className={microLabelClass}
            >
              Instructions
            </label>
            <textarea
              id={`concept-instructions-${concept.id}`}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              maxLength={4000}
              placeholder="How should the agent use these references? (palette, composition, what to keep/avoid)"
              className={`mt-2 ${textareaClass}`}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={busy !== null || name.trim() === ""}
              className={primaryButtonClass}
            >
              {busy === "save" ? "Saving…" : "Save concept"}
            </button>
            <button
              type="button"
              onClick={() => void deleteConcept()}
              disabled={busy !== null}
              className={`rounded-md border px-3.5 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                confirmDelete
                  ? "border-rose-400/60 bg-rose-400/10 text-rose-200"
                  : "border-edge text-muted hover:border-rose-400/50 hover:text-rose-200"
              }`}
            >
              {busy === "delete"
                ? "Deleting…"
                : confirmDelete
                  ? "Really delete?"
                  : "Delete"}
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-6 space-y-4">
          {concept.description?.trim() ? (
            <p className="text-sm leading-relaxed text-muted">{concept.description}</p>
          ) : null}
          {concept.instructions?.trim() ? (
            <div>
              <h3 className={microLabelClass}>Instructions</h3>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted">
                {concept.instructions}
              </p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function AgentConceptsPanel({
  username,
  agentName,
  canManage,
}: {
  username: string;
  /** Display name used in the empty-state copy. */
  agentName: string;
  canManage: boolean;
}) {
  const [concepts, setConcepts] = useState<ConceptDto[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newInstructions, setNewInstructions] = useState("");
  // Images can't attach until the concept has an id, so they're staged locally
  // and uploaded in a second step once create() returns (see createConcept).
  const [newImages, setNewImages] = useState<File[]>([]);
  const [createDragOver, setCreateDragOver] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createFileInput = useRef<HTMLInputElement | null>(null);
  const seq = useRef(0);

  const stageCreateImages = (files: File[]) => {
    if (files.length === 0) return;
    setNewImages((prev) => [...prev, ...files].slice(0, MAX_IMAGES));
  };

  const resetCreateForm = () => {
    setShowCreate(false);
    setNewName("");
    setNewDescription("");
    setNewInstructions("");
    setNewImages([]);
    setCreateError(null);
  };

  useEffect(() => {
    const id = ++seq.current;
    setPhase("loading");
    void (async () => {
      try {
        const items = await api.concepts.list(username);
        if (seq.current !== id) return;
        setConcepts(items);
        setPhase("ready");
      } catch (error) {
        if (seq.current !== id) return;
        setErrorText(describeApiFailure(error));
        setPhase("error");
      }
    })();
  }, [username]);

  const createConcept = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name || createBusy) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      // Step 1: create the concept (need its id/slug before images can attach).
      let concept = await api.concepts.create(username, {
        name,
        description: newDescription.trim() || undefined,
        instructions: newInstructions.trim() || undefined,
      });
      // Step 2: upload any staged reference images onto the new concept. A
      // failure here keeps the created concept (committed below) and surfaces
      // the error rather than losing the row.
      for (const file of newImages.slice(0, MAX_IMAGES)) {
        const problem = conceptImageFileError(file);
        if (problem) {
          setCreateError(`${file.name}: ${problem}`);
          continue;
        }
        try {
          concept = await api.concepts.uploadImage(
            username,
            concept.slug,
            await fileToUpload(file),
          );
        } catch (error) {
          setCreateError(describeApiFailure(error));
          break;
        }
      }
      setConcepts((prev) => [...prev, concept]);
      setSelectedId(concept.id);
      setShowCreate(false);
      setNewName("");
      setNewDescription("");
      setNewInstructions("");
      setNewImages([]);
    } catch (error) {
      setCreateError(describeApiFailure(error));
    } finally {
      setCreateBusy(false);
    }
  };

  const replaceConcept = (updated: ConceptDto) => {
    setConcepts((prev) =>
      prev.map((concept) => (concept.id === updated.id ? updated : concept)),
    );
  };

  const dropConcept = (slug: string) => {
    setConcepts((prev) => prev.filter((concept) => concept.slug !== slug));
    setSelectedId(null);
  };

  if (phase === "loading") return <SkeletonCards />;
  if (phase === "error") {
    return <EmptyState title="Couldn't load concepts" hint={errorText} />;
  }

  const selected = concepts.find((concept) => concept.id === selectedId) ?? null;
  const emptyHint = `Concepts teach ${agentName} an aesthetic — name one, drop in a few reference images, and ask for work in its style.`;

  const createForm =
    canManage && showCreate ? (
      <form
        onSubmit={(event) => void createConcept(event)}
        className="mt-4 space-y-3 rounded-xl border border-edge bg-surface p-4"
      >
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="Concept name (e.g. Sunset Watercolor)"
          aria-label="Concept name"
          maxLength={80}
          className={inputClass}
        />
        <input
          value={newDescription}
          onChange={(event) => setNewDescription(event.target.value)}
          placeholder="Short description (optional)"
          aria-label="Concept description"
          maxLength={2000}
          className={inputClass}
        />
        <textarea
          value={newInstructions}
          onChange={(event) => setNewInstructions(event.target.value)}
          placeholder="How should the agent use the references? (optional)"
          aria-label="Concept instructions"
          maxLength={4000}
          className={textareaClass}
        />
        <div
          onDragOver={(event) => {
            event.preventDefault();
            if (!createDragOver) setCreateDragOver(true);
          }}
          onDragLeave={() => setCreateDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setCreateDragOver(false);
            stageCreateImages([...event.dataTransfer.files]);
          }}
          className={`rounded-lg border border-dashed p-3 text-center transition-colors ${
            createDragOver ? "border-accent/60 bg-accent/5" : "border-edge"
          }`}
        >
          <input
            ref={createFileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={(event) => {
              stageCreateImages([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => createFileInput.current?.click()}
            disabled={createBusy || newImages.length >= MAX_IMAGES}
            className={quietButtonClass}
          >
            {newImages.length > 0
              ? `Reference images (${newImages.length}/${MAX_IMAGES})`
              : "Add reference images"}
          </button>
          <p className="mt-1.5 text-[11px] text-faint">or drop images here — optional</p>
          {newImages.length > 0 ? (
            <ul className="mt-2 space-y-1 text-left">
              {newImages.map((file, index) => (
                <li
                  key={`${file.name}-${index}`}
                  className="flex items-center justify-between gap-2 font-mono text-[10px] text-faint"
                >
                  <span className="truncate">
                    {index + 1}. {file.name}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    disabled={createBusy}
                    onClick={() =>
                      setNewImages((prev) => prev.filter((_, i) => i !== index))
                    }
                    className="shrink-0 rounded border border-edge px-1.5 text-muted transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={createBusy || newName.trim() === ""}
            className={primaryButtonClass}
          >
            {createBusy
              ? newImages.length > 0
                ? "Creating & uploading…"
                : "Creating…"
              : "Create concept"}
          </button>
          <button
            type="button"
            onClick={resetCreateForm}
            disabled={createBusy}
            className={quietButtonClass}
          >
            Cancel
          </button>
        </div>
        {createError ? <p className="text-xs text-rose-300">{createError}</p> : null}
      </form>
    ) : null;

  if (concepts.length === 0) {
    return (
      <div>
        <EmptyState
          title="No concepts yet"
          hint={emptyHint}
          action={
            canManage && !showCreate ? (
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className={primaryButtonClass}
              >
                New concept
              </button>
            ) : undefined
          }
        />
        {createForm}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Ask for work “in the style of” any concept below.
        </p>
        {canManage && !showCreate ? (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className={quietButtonClass}
          >
            New concept
          </button>
        ) : null}
      </div>
      {createForm}

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {concepts.map((concept) => {
          const isSelected = concept.id === selectedId;
          return (
            <button
              key={concept.id}
              type="button"
              aria-expanded={isSelected}
              onClick={() => setSelectedId(isSelected ? null : concept.id)}
              className={`group overflow-hidden rounded-xl border text-left transition-colors ${
                isSelected
                  ? "border-accent/60 bg-accent/5"
                  : "border-edge bg-surface hover:border-accent/40"
              }`}
            >
              <div className="aspect-[4/3] overflow-hidden bg-raised">
                <ConceptCover concept={concept} />
              </div>
              <div className="p-4">
                <h2 className="truncate text-sm font-medium text-foreground">
                  {concept.name}
                </h2>
                <p className="mt-1 truncate text-xs text-faint">
                  {concept.description?.trim() ||
                    `${concept.images.length} reference image${concept.images.length === 1 ? "" : "s"}`}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {selected ? (
        <ConceptDetail
          key={selected.id}
          username={username}
          concept={selected}
          canManage={canManage}
          onChanged={replaceConcept}
          onDeleted={dropConcept}
        />
      ) : null}
    </div>
  );
}
