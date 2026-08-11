import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const provider = read("../components/agents/settings/unsaved-changes.tsx");
const layout = read("../app/agents/[username]/settings/layout.tsx");
const identity = read("../components/agents/settings/identity-form.tsx");
const tools = read("../components/agents/settings/tools-form.tsx");
const persona = read("../components/agents/settings/persona-editor.tsx");
const profile = read("../components/agents/agent-profile.tsx");
const concepts = read("../components/agents/agent-concepts.tsx");

function count(source: string, token: string): number {
  return source.split(token).length - 1;
}

function expectGuardedEditor(source: string, expectedRegistrations = 1) {
  expect(count(source, "useSettingsUnsavedChanges({")).toBe(expectedRegistrations);
  expect(count(source, "Discard changes")).toBeGreaterThanOrEqual(expectedRegistrations);
}

describe("agent settings unsaved-change protection", () => {
  it("wraps every settings page in the navigation guard", () => {
    expect(layout).toContain("<SettingsUnsavedChangesProvider>");
    expect(layout).toContain("</SettingsUnsavedChangesProvider>");
  });

  it("warns for browser exits and offers all three explicit navigation choices", () => {
    expect(provider).toContain('window.addEventListener("beforeunload"');
    expect(provider).toContain('document.addEventListener("click", interceptNavigation, true)');
    expect(provider).toContain('role="alertdialog"');
    expect(provider).toContain("Keep editing");
    expect(provider).toContain("Discard changes");
    expect(provider).toContain("Save and continue");
    expect(provider.indexOf("if (await editor.save())")).toBeLessThan(
      provider.indexOf("continueTo(href)", provider.indexOf("if (await editor.save())")),
    );
  });

  it("registers all persistent text/runtime settings editors and exposes discard beside save", () => {
    expectGuardedEditor(identity);
    expectGuardedEditor(tools);
    expectGuardedEditor(persona);
    expectGuardedEditor(profile, 2); // Skills and Memory live in the shared profile module.
    expect(count(concepts, "useSettingsUnsavedChanges({")).toBe(2);
    expect(concepts).toContain("Discard changes");
    expect(concepts).toContain("discard: resetCreateForm");
  });

  it("mutation-pins removal of a guard or discard action", () => {
    const withoutIdentityGuard = identity.replace("useSettingsUnsavedChanges({", "removedGuard({");
    const withoutPersonaDiscard = persona.replace("Discard changes", "Throw changes away");

    expect(() => expectGuardedEditor(withoutIdentityGuard)).toThrow();
    expect(() => expectGuardedEditor(withoutPersonaDiscard)).toThrow();
  });
});
