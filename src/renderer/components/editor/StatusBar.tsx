import React from "react";
import type { LLMProvider, OllamaStatus } from "../../../shared/rpc-types";

type SaveStatus = "saved" | "saving" | "unsaved";

interface StatusBarProps {
  ollamaStatus: OllamaStatus;
  sidebarAgentProvider?: LLMProvider;
  sidebarAgentModel?: string;
  wordCount: number;
  onToggleAI: () => void;
  saveStatus?: SaveStatus;
}

export function StatusBar({ ollamaStatus, sidebarAgentProvider = "ollama", sidebarAgentModel, wordCount, onToggleAI, saveStatus = "saved" }: StatusBarProps) {
  const connected = sidebarAgentProvider === "ollama" ? ollamaStatus.connected : true;
  const label = sidebarAgentProvider === "anthropic"
    ? "Claude"
    : sidebarAgentProvider === "deepseek"
      ? "DeepSeek"
      : sidebarAgentProvider === "openai"
        ? "OpenAI"
        : "Ollama";
  const modelLabel = sidebarAgentModel || (sidebarAgentProvider === "ollama" ? ollamaStatus.activeModel : null);

  return (
    <div className="flex items-center justify-between px-4 py-1 bg-gray-800 text-gray-300 text-xs border-t border-gray-700 select-none">
      <div className="flex items-center gap-4">
        {/* AI backend status */}
        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full ${
              connected ? "bg-green-400" : "bg-red-400"
            }`}
          />
          <span>
            {label} {connected ? "connected" : "disconnected"}
          </span>
        </div>

        {/* Active model */}
        {modelLabel && (
          <span className="text-gray-400">
            Model: {modelLabel}
          </span>
        )}
      </div>

      <div className="flex items-center gap-4">
        {/* Word count */}
        <span>{wordCount.toLocaleString()} words</span>

        {/* Save status */}
        <span className={`flex items-center gap-1 ${
          saveStatus === "saved" ? "text-green-400" :
          saveStatus === "saving" ? "text-yellow-400" :
          "text-orange-400"
        }`}>
          {saveStatus === "saved" && (
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
          {saveStatus === "saving" && (
            <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
          {saveStatus === "unsaved" && (
            <span className="w-2 h-2 rounded-full bg-orange-400" />
          )}
          {saveStatus === "saved" ? "Saved" : saveStatus === "saving" ? "Saving\u2026" : "Unsaved"}
        </span>

        {/* AI toggle */}
        <button
          onClick={onToggleAI}
          className="px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 transition-colors"
        >
          AI
        </button>
      </div>
    </div>
  );
}
