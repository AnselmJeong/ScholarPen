import { ExtensionSlot } from "../../extensions/slots";
import { useClaudeStatus } from "../../hooks/useClaudeStatus";
import React from "react";
import type { LLMProvider, OllamaStatus } from "../../../shared/rpc-types";
import { useCodexStatus } from "../../hooks/useCodexStatus";

type SaveStatus = "saved" | "saving" | "unsaved";

interface StatusBarProps {
  ollamaStatus: OllamaStatus;
  sidebarAgentProvider?: LLMProvider;
  sidebarAgentModel?: string;
  onToggleAI: () => void;
  saveStatus?: SaveStatus;
}

export function StatusBar({ ollamaStatus, sidebarAgentProvider = "ollama", sidebarAgentModel, onToggleAI, saveStatus = "saved" }: StatusBarProps) {
  const codexStatus = useCodexStatus(sidebarAgentProvider === "codex");
  const { status: claudeStatus } = useClaudeStatus(sidebarAgentProvider === "anthropic");
  const subscriptionStatus = sidebarAgentProvider === "codex" ? codexStatus : sidebarAgentProvider === "anthropic" ? claudeStatus : null;
  const isSubscription = sidebarAgentProvider === "codex" || sidebarAgentProvider === "anthropic";
  const labels: Record<LLMProvider, string> = { ollama: "Ollama", anthropic: "Claude (구독)", deepseek: "DeepSeek", openai: "OpenAI", codex: "Codex (ChatGPT)" };
  const label = labels[sidebarAgentProvider];
  const connected = isSubscription ? subscriptionStatus?.state === "connected"
    : sidebarAgentProvider === "ollama" ? ollamaStatus.connected : true;
  const checking = isSubscription && (!subscriptionStatus || subscriptionStatus.state === "signingIn");
  const connectionLabel = isSubscription
    ? !subscriptionStatus ? "checking…" : subscriptionStatus.state === "signingIn" ? "signing in…"
      : subscriptionStatus.state === "unavailable" ? "unavailable" : subscriptionStatus.state === "error" ? "error"
      : connected ? "connected" : "disconnected"
    : connected ? "connected" : "disconnected";
  const modelLabel = sidebarAgentModel || (sidebarAgentProvider === "ollama" ? ollamaStatus.activeModel : sidebarAgentProvider === "codex" ? "Codex default" : sidebarAgentProvider === "anthropic" ? "구독 기본 모델" : null);

  const dot = checking ? "bg-amber-400" : connected ? "bg-emerald-500" : "bg-red-500";
  const saveTone = saveStatus === "saved" ? "text-emerald-600 dark:text-emerald-400"
    : saveStatus === "saving" ? "text-amber-600 dark:text-amber-400"
    : "text-orange-600 dark:text-orange-400";

  return (
    <div className="workbench-statusbar flex h-6 flex-shrink-0 items-stretch justify-between border-t border-sidebar-border bg-sidebar text-[11px] text-muted-foreground select-none">
      <div className="flex min-w-0 items-stretch">
        {/* AI backend status */}
        <div className="workbench-status-item" title={subscriptionStatus?.error}>
          <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${dot}`} aria-hidden="true" />
          <span className="truncate">
            {label} {connectionLabel}
          </span>
        </div>

        {/* Active model */}
        {modelLabel && (
          <div className="workbench-status-item min-w-0">
            <span className="truncate font-mono-ui">
              Model: {modelLabel}
            </span>
          </div>
        )}
      </div>

      <div className="flex items-stretch">
        {/* Word count */}
        <div className="workbench-status-item font-mono-ui empty:hidden"><ExtensionSlot name="status" /></div>

        {/* Save status */}
        <span className={`workbench-status-item ${saveTone}`}>
          {saveStatus === "saved" && (
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
          {saveStatus === "saving" && (
            <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
          {saveStatus === "unsaved" && (
            <span className="w-1.5 h-1.5 rounded-full bg-orange-500" aria-hidden="true" />
          )}
          {saveStatus === "saved" ? "Saved" : saveStatus === "saving" ? "Saving\u2026" : "Unsaved"}
        </span>

        {/* AI toggle */}
        <button
          type="button"
          onClick={onToggleAI}
          title="Toggle AI sidebar"
          className="workbench-status-item font-semibold text-foreground/80 hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          AI
        </button>
      </div>
    </div>
  );
}
