"use client";

import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { primaryButtonClass, quietButtonClass } from "@/components/agents/form-fields";

type UnsavedEditor = {
  id: string;
  label: string;
  dirty: boolean;
  saving: boolean;
  save: () => Promise<boolean>;
  discard: () => void;
};

type Registry = {
  register: (editor: UnsavedEditor) => void;
  unregister: (id: string) => void;
};

const UnsavedChangesContext = createContext<Registry | null>(null);

function navigationHref(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest<HTMLAnchorElement>("a[href]");
  if (!anchor || anchor.download || anchor.target === "_blank") return null;
  return anchor.href;
}

export function SettingsUnsavedChangesProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [editors, setEditors] = useState<Map<string, UnsavedEditor>>(() => new Map());
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const stayButton = useRef<HTMLButtonElement | null>(null);

  const registry = useRef<Registry>({
    register(next) {
      setEditors((current) => {
        const updated = new Map(current);
        updated.set(next.id, next);
        return updated;
      });
    },
    unregister(id) {
      setEditors((current) => {
        if (!current.has(id)) return current;
        const updated = new Map(current);
        updated.delete(id);
        return updated;
      });
    },
  });

  const dirtyEditors = [...editors.values()].filter((candidate) => candidate.dirty);
  const hasDirtyChanges = dirtyEditors.length > 0;
  const anySaving = dirtyEditors.some((candidate) => candidate.saving);

  useEffect(() => {
    if (!hasDirtyChanges) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasDirtyChanges]);

  useEffect(() => {
    if (!hasDirtyChanges) return;
    const interceptNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const href = navigationHref(event.target);
      if (!href || href === window.location.href) return;
      event.preventDefault();
      event.stopPropagation();
      setModalError(null);
      setPendingHref(href);
    };
    document.addEventListener("click", interceptNavigation, true);
    return () => document.removeEventListener("click", interceptNavigation, true);
  }, [hasDirtyChanges]);

  useEffect(() => {
    if (!pendingHref) return;
    stayButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !committing) setPendingHref(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [committing, pendingHref]);

  const continueTo = (href: string) => {
    setPendingHref(null);
    setModalError(null);
    const url = new URL(href, window.location.href);
    if (url.origin === window.location.origin) {
      router.push(`${url.pathname}${url.search}${url.hash}`);
    } else {
      window.location.assign(url.href);
    }
  };

  const discardAndContinue = () => {
    if (!pendingHref || dirtyEditors.length === 0) return;
    const href = pendingHref;
    for (const editor of dirtyEditors) editor.discard();
    continueTo(href);
  };

  const saveAndContinue = async () => {
    if (!pendingHref || dirtyEditors.length === 0 || anySaving || committing) return;
    const href = pendingHref;
    setCommitting(true);
    setModalError(null);
    try {
      for (const editor of dirtyEditors) {
        if (!(await editor.save())) {
          setModalError("That save didn’t complete. Your edits are still here—retry or keep editing.");
          return;
        }
      }
      continueTo(href);
    } finally {
      setCommitting(false);
    }
  };

  return (
    <UnsavedChangesContext.Provider value={registry.current}>
      {children}
      {pendingHref && dirtyEditors.length > 0 ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !committing) setPendingHref(null);
          }}
        >
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="unsaved-settings-title"
            aria-describedby="unsaved-settings-description"
            className="w-full max-w-md rounded-2xl border border-edge bg-raised p-5 shadow-2xl"
          >
            <h2 id="unsaved-settings-title" className="text-lg font-medium text-foreground">
              Save your changes?
            </h2>
            <p id="unsaved-settings-description" className="mt-2 text-sm leading-relaxed text-muted">
              {dirtyEditors.length === 1
                ? `You changed ${dirtyEditors[0]!.label}.`
                : `You have changes in ${dirtyEditors.length} settings areas.`}{" "}
              Save before leaving, discard those edits, or stay here.
            </p>
            {modalError ? (
              <p className="mt-3 rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-xs text-danger">
                {modalError}
              </p>
            ) : null}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                ref={stayButton}
                type="button"
                onClick={() => setPendingHref(null)}
                disabled={committing}
                className={quietButtonClass}
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={discardAndContinue}
                disabled={committing}
                className={quietButtonClass}
              >
                Discard changes
              </button>
              <button
                type="button"
                onClick={() => void saveAndContinue()}
                disabled={anySaving || committing}
                className={primaryButtonClass}
              >
                {anySaving || committing ? "Saving…" : "Save and continue"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </UnsavedChangesContext.Provider>
  );
}

export function useSettingsUnsavedChanges({
  label,
  dirty,
  saving,
  save,
  discard,
}: Omit<UnsavedEditor, "id">) {
  const registry = useContext(UnsavedChangesContext);
  const id = useId();
  const saveRef = useRef(save);
  const discardRef = useRef(discard);
  saveRef.current = save;
  discardRef.current = discard;

  useEffect(() => {
    if (!registry) return;
    const registration: UnsavedEditor = {
      id,
      label,
      dirty,
      saving,
      save: () => saveRef.current(),
      discard: () => discardRef.current(),
    };
    registry.register(registration);
    return () => registry.unregister(id);
  }, [dirty, id, label, registry, saving]);
}
