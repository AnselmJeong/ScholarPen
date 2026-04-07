import React, { useState, useRef, useCallback } from "react";
import type { OllamaStatus, ProjectInfo } from "../../../shared/rpc-types";
import type { BlockNoteEditor } from "@blocknote/core";
import { rpc } from "../../rpc";

interface AISidebarProps {
  project: ProjectInfo | null;
  ollamaStatus: OllamaStatus;
  editor: BlockNoteEditor<any, any, any> | null;
  onClose: () => void;
}

type ContextMode = "selection" | "page" | "manuscript";

interface Message {
  role: "user" | "assistant";
  content: string;
}

// Extract plain text from BlockNote blocks for context
function blocksToText(blocks: unknown[]): string {
  function extract(node: unknown): string {
    if (!node || typeof node !== "object") return "";
    if (Array.isArray(node)) return node.map(extract).join("\n");
    const obj = node as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    const parts: string[] = [];
    if (Array.isArray(obj.content)) parts.push(extract(obj.content));
    if (Array.isArray(obj.children)) parts.push(extract(obj.children));
    return parts.join("\n");
  }
  return blocks.map(extract).join("\n\n");
}

function getContextLabel(mode: ContextMode): string {
  return mode === "selection" ? "Selection" : mode === "page" ? "Page" : "Manuscript";
}

export function AISidebar({
  project: _project,
  ollamaStatus,
  editor,
  onClose,
}: AISidebarProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [contextMode, setContextMode] = useState<ContextMode>("page");
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }, []);

  const buildSystemPrompt = useCallback((): string => {
    if (!editor) return "You are a helpful academic writing assistant.";

    let context = "";
    if (contextMode === "selection") {
      const selection = editor.getSelection();
      if (selection) {
        context = blocksToText(selection.blocks);
      }
    } else if (contextMode === "page" || contextMode === "manuscript") {
      context = blocksToText(editor.document);
    }

    const contextLabel = getContextLabel(contextMode);
    return (
      `You are a helpful academic writing assistant. ` +
      (context.trim()
        ? `The user is working on the following ${contextLabel.toLowerCase()}:\n\n${context}\n\nHelp them with their request.`
        : "Help the user with their academic writing.")
    );
  }, [editor, contextMode]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || loading) return;
    if (!ollamaStatus.connected) {
      setMessages((prev) => [
        ...prev,
        { role: "user", content: input.trim() },
        { role: "assistant", content: "Ollama is not connected. Please start Ollama first." },
      ]);
      setInput("");
      scrollToBottom();
      return;
    }

    const userMsg = input.trim();
    setInput("");
    const newMessages: Message[] = [...messages, { role: "user", content: userMsg }];
    setMessages(newMessages);
    setLoading(true);

    // Placeholder for streaming assistant reply
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
    scrollToBottom();

    const model = ollamaStatus.activeModel ?? ollamaStatus.models[0] ?? "gemma3";
    const systemPrompt = buildSystemPrompt();

    abortRef.current = new AbortController();
    let accumulated = "";

    try {
      // Use RPC to call Bun which proxies to Ollama (avoids CORS issues)
      await rpc.generateTextStream(
        model,
        [
          { role: "system", content: systemPrompt },
          ...newMessages.map((m) => ({ role: m.role, content: m.content })),
        ],
        (chunk: string) => {
          accumulated += chunk;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content: accumulated,
            };
            return updated;
          });
        }
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // user stopped generation
      } else {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: `Error: ${(err as Error).message}`,
          };
          return updated;
        });
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
      scrollToBottom();
    }
  }, [input, loading, messages, ollamaStatus, buildSystemPrompt, scrollToBottom]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleClear = useCallback(() => {
    setMessages([]);
  }, []);

  const activeModel =
    ollamaStatus.connected
      ? (ollamaStatus.activeModel ?? ollamaStatus.models[0] ?? "—")
      : "—";

  return (
    <div className="w-72 flex-shrink-0 border-l border-gray-200 bg-white flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200">
        <div>
          <h2 className="text-sm font-semibold text-gray-700">AI Assistant</h2>
          {ollamaStatus.connected && (
            <p className="text-xs text-gray-400">{activeModel}</p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              onClick={handleClear}
              title="Clear history"
              className="text-xs text-gray-400 hover:text-gray-600 px-1"
            >
              Clear
            </button>
          )}
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none"
          >
            ×
          </button>
        </div>
      </div>

      {/* Context selector */}
      <div className="flex px-3 py-1.5 gap-1 border-b border-gray-100">
        <span className="text-xs text-gray-400 self-center mr-1">Context:</span>
        {(["selection", "page", "manuscript"] as ContextMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => setContextMode(mode)}
            className={`text-xs px-2 py-0.5 rounded ${
              contextMode === mode
                ? "bg-blue-500 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {getContextLabel(mode)}
          </button>
        ))}
      </div>

      {/* Chat history */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && (
          <p className="text-xs text-gray-400 text-center mt-4">
            {ollamaStatus.connected
              ? "Ask anything about your manuscript"
              : "Start Ollama to use AI features"}
          </p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className="flex flex-col gap-0.5">
            <span className="text-xs text-gray-400 px-1">
              {msg.role === "user" ? "You" : activeModel}
            </span>
            <div
              className={`text-xs rounded-lg px-3 py-2 whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-blue-50 text-gray-800 border border-blue-100"
                  : "bg-gray-50 text-gray-800 border border-gray-100"
              }`}
            >
              {msg.content || (
                <span className="text-gray-300 animate-pulse">▋</span>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-gray-200 p-2">
        <div className="flex gap-1">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            rows={2}
            placeholder={
              ollamaStatus.connected
                ? "Ask AI... (Enter to send, Shift+Enter for newline)"
                : "Ollama not connected..."
            }
            disabled={!ollamaStatus.connected}
            className="flex-1 text-xs px-2 py-1 rounded border border-gray-300 resize-none focus:outline-none focus:border-blue-400 disabled:opacity-50"
          />
          {loading ? (
            <button
              onClick={handleStop}
              className="text-xs px-2 py-1 rounded bg-red-500 text-white hover:bg-red-600 self-end"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim() || !ollamaStatus.connected}
              className="text-xs px-2 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 self-end"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
