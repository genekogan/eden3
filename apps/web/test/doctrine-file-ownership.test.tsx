import { BOOTSTRAP_FILE_NAMES } from "@eden3/shared";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DoctrineOwnershipNotice } from "../components/agents/doctrine-ownership-notice";
import {
  DOCTRINE_FILE_OWNERSHIP,
  doctrineFileOwnership,
  type DoctrineSyncState,
} from "../lib/doctrine-file-ownership";

describe("doctrine file ownership", () => {
  it("covers the complete rendered doctrine set with one truthful two-way file", () => {
    expect(Object.keys(DOCTRINE_FILE_OWNERSHIP).sort()).toEqual(
      [...BOOTSTRAP_FILE_NAMES].sort(),
    );

    const resolved = BOOTSTRAP_FILE_NAMES.map((file) =>
      doctrineFileOwnership(file, "verdalis"),
    );
    expect(resolved.filter((item) => item?.kind === "two-way-settings")).toHaveLength(1);
    expect(doctrineFileOwnership("SOUL.md", "verdalis")).toMatchObject({
      badge: "Linked · Settings → Persona",
      editableInWorkspace: true,
      settingsLinks: [
        {
          href: "/agents/verdalis/settings/persona",
          label: "Open Settings → Persona",
        },
      ],
    });
  });

  it("keeps generated doctrine read-only and points only to real settings owners", () => {
    expect(doctrineFileOwnership("IDENTITY.md", "verdalis")).toMatchObject({
      kind: "settings-generated",
      badge: "Settings-managed",
      editableInWorkspace: false,
      settingsLinks: [
        { href: "/agents/verdalis/settings/identity" },
        { href: "/agents/verdalis/settings/tools" },
      ],
    });
    expect(doctrineFileOwnership("MEMORY.md", "verdalis")).toMatchObject({
      kind: "linked-settings",
      badge: "Linked · Settings → Memory",
      editableInWorkspace: false,
      settingsLinks: [{ href: "/agents/verdalis/settings/memory" }],
    });
    expect(doctrineFileOwnership("AGENTS.md", "verdalis")).toMatchObject({
      kind: "platform-managed",
      badge: "Platform-managed",
      editableInWorkspace: false,
      settingsLinks: [],
    });
    expect(doctrineFileOwnership("notes/idea.md", "verdalis")).toBeNull();
  });

  it.each<[DoctrineSyncState, string]>([
    ["synced", "Synced with Settings → Persona"],
    ["unsaved", "Unsaved changes"],
    ["saving", "Saving to Settings → Persona…"],
    ["conflict", "Conflict — choose reload or keep editing"],
  ])("renders the SOUL.md %s state visibly", (syncState, expected) => {
    const ownership = doctrineFileOwnership("SOUL.md", "verdalis");
    expect(ownership).not.toBeNull();
    const html = renderToStaticMarkup(
      <DoctrineOwnershipNotice ownership={ownership!} syncState={syncState} revision={12} />,
    );
    expect(html).toContain("Linked · Settings → Persona");
    expect(html).toContain(expected);
    expect(html).toContain("Revision 12");
    expect(html).toContain('href="/agents/verdalis/settings/persona"');
  });

  it("never creates a settings/config affordance for Eve", () => {
    for (const file of BOOTSTRAP_FILE_NAMES) {
      const ownership = doctrineFileOwnership(file, "EVE");
      expect(ownership).toMatchObject({
        kind: "platform-managed",
        badge: "Platform-managed",
        editableInWorkspace: false,
        settingsLinks: [],
      });
      const html = renderToStaticMarkup(
        <DoctrineOwnershipNotice ownership={ownership!} />,
      );
      expect(html).not.toContain("/settings");
      expect(html).not.toContain("Edit in Settings");
    }
  });
});
