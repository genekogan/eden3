"use client";

/**
 * Shared save machinery for the per-section agent settings forms. Each form
 * owns a subset of AgentDto fields; this hook diffs against the loaded agent
 * (from the shell's SelectedAgentProvider), PATCHes just the dirty keys, and
 * refreshes the shared cache so the selector/sidebar update too.
 */

import { useCallback, useState } from "react";
import { api } from "@/lib/api";
import type { AgentUpdateInput } from "@/lib/types";
import { apiErrorDetail } from "@/components/agents/agent-utils";
import { useSelectedAgent } from "@/components/shell/selected-agent-context";

export function useAgentPatch(username: string) {
  const { refresh } = useSelectedAgent();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const save = useCallback(
    async (patch: AgentUpdateInput, successMessage: string): Promise<boolean> => {
      if (Object.keys(patch).length === 0) {
        setToast("Nothing to save — no changes.");
        return true;
      }
      setSaving(true);
      setSaveError(null);
      try {
        await api.agents.update(username, patch);
        refresh(); // re-pull into the shared cache
        setToast(successMessage);
        return true;
      } catch (error) {
        setSaveError(apiErrorDetail(error));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [username, refresh],
  );

  return { saving, saveError, toast, setToast, save };
}
