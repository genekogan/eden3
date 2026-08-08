import type { BootstrapFileName } from "@eden3/shared";
import { isEveUsername } from "@/lib/eve";

export type DoctrineOwnershipKind =
  | "two-way-settings"
  | "settings-generated"
  | "linked-settings"
  | "platform-managed";

export interface DoctrineSettingsLink {
  label: string;
  section: "identity" | "persona" | "tools" | "skills" | "memory";
}

export interface DoctrineFileOwnership {
  file: BootstrapFileName;
  kind: DoctrineOwnershipKind;
  badge: string;
  detail: string;
  editableInWorkspace: boolean;
  settingsLinks: readonly (DoctrineSettingsLink & { href: string })[];
}

type DoctrineOwnershipDefinition = Omit<
  DoctrineFileOwnership,
  "file" | "settingsLinks"
> & {
  settingsLinks: readonly DoctrineSettingsLink[];
};

/**
 * Exhaustive ownership policy for the seven rendered doctrine files.
 *
 * SOUL.md is the only file with a proven exact file -> DB -> file round trip.
 * Generated files stay read-only in Workspace until their Settings parsers
 * exist, so a later Settings save cannot silently replace a hand edit.
 */
export const DOCTRINE_FILE_OWNERSHIP = {
  "SOUL.md": {
    kind: "two-way-settings",
    badge: "Linked · Settings → Persona",
    detail: "Exact two-way sync with Persona settings.",
    editableInWorkspace: true,
    settingsLinks: [{ label: "Open Settings → Persona", section: "persona" }],
  },
  "IDENTITY.md": {
    kind: "settings-generated",
    badge: "Settings-managed",
    detail:
      "Generated from Identity and runtime settings. It is read-only here to prevent a later Settings save from replacing workspace edits.",
    editableInWorkspace: false,
    settingsLinks: [
      { label: "Edit identity in Settings", section: "identity" },
      { label: "Edit runtime in Settings", section: "tools" },
    ],
  },
  "MEMORY.md": {
    kind: "linked-settings",
    badge: "Linked · Settings → Memory",
    detail:
      "Memory settings and the agent runtime both update this file. It is read-only here so corrections keep their provenance.",
    editableInWorkspace: false,
    settingsLinks: [{ label: "Edit in Settings → Memory", section: "memory" }],
  },
  "TOOLS.md": {
    kind: "platform-managed",
    badge: "Platform-managed",
    detail:
      "Eden maintains tool guidance and the installed-skill manifest. This file is read-only here.",
    editableInWorkspace: false,
    settingsLinks: [{ label: "Manage skills in Settings", section: "skills" }],
  },
  "AGENTS.md": {
    kind: "platform-managed",
    badge: "Platform-managed",
    detail: "Eden maintains operating, privacy, and safety doctrine. This file is read-only here.",
    editableInWorkspace: false,
    settingsLinks: [],
  },
  "USER.md": {
    kind: "platform-managed",
    badge: "Platform-managed",
    detail: "Eden maintains authenticated user-context doctrine. This file is read-only here.",
    editableInWorkspace: false,
    settingsLinks: [],
  },
  "HEARTBEAT.md": {
    kind: "platform-managed",
    badge: "Platform-managed",
    detail: "Eden and the runtime own heartbeat behavior. This file is read-only here.",
    editableInWorkspace: false,
    settingsLinks: [],
  },
} as const satisfies Record<BootstrapFileName, DoctrineOwnershipDefinition>;

export function doctrineFileOwnership(
  filePath: string,
  username: string,
): DoctrineFileOwnership | null {
  if (filePath.includes("/")) return null;
  const definition = DOCTRINE_FILE_OWNERSHIP[filePath as BootstrapFileName] as
    | DoctrineOwnershipDefinition
    | undefined;
  if (!definition) return null;

  // Eve's configuration is platform-owned and intentionally has no Settings
  // affordance, even if a caller reaches this resolver outside normal routing.
  if (isEveUsername(username)) {
    return {
      file: filePath as BootstrapFileName,
      kind: "platform-managed",
      badge: "Platform-managed",
      detail: "Eve's doctrine is maintained by Eden and is read-only.",
      editableInWorkspace: false,
      settingsLinks: [],
    };
  }

  const base = `/agents/${encodeURIComponent(username)}/settings`;
  return {
    file: filePath as BootstrapFileName,
    ...definition,
    settingsLinks: definition.settingsLinks.map((link) => ({
      ...link,
      href: `${base}/${link.section}`,
    })),
  };
}

export type DoctrineSyncState = "synced" | "unsaved" | "saving" | "conflict";

export function doctrineSyncStateLabel(state: DoctrineSyncState): string {
  switch (state) {
    case "synced":
      return "Synced with Settings → Persona";
    case "unsaved":
      return "Unsaved changes";
    case "saving":
      return "Saving to Settings → Persona…";
    case "conflict":
      return "Conflict — choose reload or keep editing";
  }
}
