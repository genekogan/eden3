import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BOOTSTRAP_FILE_NAMES,
  type BootstrapFileName,
  type BootstrapFileSet,
} from "@eden3/shared";

const WORKSPACE_TEMPLATES = fileURLToPath(
  new URL("../../../packages/gateway/workspace-templates/", import.meta.url),
);

/**
 * Render the exact seven gateway templates around a builder/gallery persona.
 * This mirrors the provisioner's one-pass placeholder substitution without
 * making the web package depend on gateway runtime code.
 */
export function renderedDoctrine(persona: string): BootstrapFileSet {
  const vars: Record<string, string> = {
    NAME: "Rendered Agent",
    USERNAME: "rendered-agent",
    DESCRIPTION: "An agent created through Eden.",
    PERSONA: persona,
    GREETING: "Ready.",
    VOICE: "unspecified",
    THINKING_LEVEL: "balanced",
    MEMORY_SEED: "",
    PROVISIONED_AT: "2026-07-31T00:00:00.000Z",
  };
  return Object.fromEntries(
    BOOTSTRAP_FILE_NAMES.map((file) => [
      file,
      readFileSync(path.join(WORKSPACE_TEMPLATES, file), "utf8").replace(
        /\{\{([A-Z_]+)\}\}/g,
        (match, key: string) => vars[key] ?? match,
      ),
    ]),
  ) as Record<BootstrapFileName, string>;
}
