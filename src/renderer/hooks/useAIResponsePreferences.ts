import { useCallback, useEffect, useState } from "react";
import { AGENT_THINKING_LEVELS } from "../../shared/agent-thinking";
import type { AgentThinkingLevel } from "../../shared/rpc-types";

export interface AIResponsePreferences {
  searchEnabled: boolean;
  thinkingLevel: AgentThinkingLevel;
}

const STORAGE_KEY = "scholarpen.ai-response-preferences";
const DEFAULTS: AIResponsePreferences = { searchEnabled: false, thinkingLevel: "none" };

function readPreferences(): AIResponsePreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return {
      searchEnabled: typeof saved?.searchEnabled === "boolean" ? saved.searchEnabled : DEFAULTS.searchEnabled,
      thinkingLevel: AGENT_THINKING_LEVELS.includes(saved?.thinkingLevel)
        ? saved.thinkingLevel : DEFAULTS.thinkingLevel,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Owned by App so session resets and sidebar unmounts cannot reset user choices. */
export function useAIResponsePreferences() {
  const [preferences, setPreferences] = useState<AIResponsePreferences>(readPreferences);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); }
    catch { /* Keep the in-memory preference if browser storage is unavailable. */ }
  }, [preferences]);

  const setSearchEnabled = useCallback((searchEnabled: boolean) => {
    setPreferences(current => ({ ...current, searchEnabled }));
  }, []);
  const setThinkingLevel = useCallback((thinkingLevel: AgentThinkingLevel) => {
    setPreferences(current => ({ ...current, thinkingLevel }));
  }, []);

  return { preferences, setSearchEnabled, setThinkingLevel };
}
