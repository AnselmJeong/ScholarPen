import React from "react";
import type { OllamaStatus } from "../../../shared/rpc-types";

interface StatusBarProps {
  ollamaStatus: OllamaStatus;
  wordCount: number;
  onToggleAI: () => void;
}

export function StatusBar({ ollamaStatus, wordCount, onToggleAI }: StatusBarProps) {
  return (
    <div className="flex items-center justify-between px-4 py-1 bg-gray-800 text-gray-300 text-xs border-t border-gray-700 select-none">
      <div className="flex items-center gap-4">
        {/* Ollama status */}
        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full ${
              ollamaStatus.connected ? "bg-green-400" : "bg-red-400"
            }`}
          />
          <span>
            Ollama {ollamaStatus.connected ? "connected" : "disconnected"}
          </span>
        </div>

        {/* Active model */}
        {ollamaStatus.activeModel && (
          <span className="text-gray-400">
            Model: {ollamaStatus.activeModel}
          </span>
        )}
      </div>

      <div className="flex items-center gap-4">
        {/* Word count */}
        <span>{wordCount.toLocaleString()} words</span>

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
