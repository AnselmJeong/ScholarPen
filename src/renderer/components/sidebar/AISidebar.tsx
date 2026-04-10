import React, { useState, useRef, useCallback } from "react";
import { X, RotateCcw, Copy, Settings2, Paperclip, Mic, Send, StopCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { OllamaStatus, ProjectInfo } from "@shared/rpc-types";
import type { BlockNoteEditor } from "@blocknote/core";

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

export function AISidebar({ project: _project, ollamaStatus, editor, onClose }: AISidebarProps) {
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
      if (selection) context = blocksToText(selection.blocks);
    } else {
      context = blocksToText(editor.document);
    }
    const label = contextMode === "selection" ? "selection" : contextMode === "page" ? "document" : "manuscript";
    return `You are a helpful academic writing assistant.` +
      (context.trim() ? ` The user is working on the following ${label}:\n\n${context}\n\nHelp them with their request.` : "");
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
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
    scrollToBottom();

    const model = ollamaStatus.activeModel ?? ollamaStatus.models[0] ?? "gemma3";
    const systemPrompt = buildSystemPrompt();
    abortRef.current = new AbortController();
    let accumulated = "";

    try {
      // Call Ollama directly from the webview — Electrobun's streaming RPC
      // callback pattern is unreliable; direct fetch avoids that entirely.
      const response = await fetch("http://localhost:11434/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            ...newMessages.map((m) => ({ role: m.role, content: m.content })),
          ],
          stream: true,
          think: false, // disable qwen3 chain-of-thought mode
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`Ollama error: HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as {
              message?: { content?: string };
              done?: boolean;
            };
            if (parsed.message?.content) {
              accumulated += parsed.message.content;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: "assistant", content: accumulated };
                return updated;
              });
            }
          } catch {
            // skip malformed lines
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: `Error: ${(err as Error).message}` };
          return updated;
        });
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
      scrollToBottom();
    }
  }, [input, loading, messages, ollamaStatus, buildSystemPrompt, scrollToBottom]);

  const activeModel = ollamaStatus.connected
    ? (ollamaStatus.activeModel ?? ollamaStatus.models[0] ?? "—")
    : "—";

  return (
    <div className="w-72 flex-shrink-0 border-l border-border bg-background flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <span className={cn(
            "h-2 w-2 rounded-full flex-shrink-0",
            ollamaStatus.connected ? "bg-emerald-500" : "bg-muted-foreground"
          )} />
          <div>
            <p className="text-sm font-semibold text-foreground">AI Assistant (Ollama)</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-6 w-6">
            <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </div>
      </div>

      {/* Context selector */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border">
        <span className="text-xs text-muted-foreground mr-1">Context:</span>
        {(["selection", "page", "manuscript"] as ContextMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => setContextMode(mode)}
            className={cn(
              "text-xs px-2 py-0.5 rounded-md capitalize transition-colors",
              contextMode === mode
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
          >
            {mode}
          </button>
        ))}
      </div>

      {/* Chat history */}
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-4">
          {messages.length === 0 && (
            <p className="text-xs text-muted-foreground text-center mt-8 px-4 leading-relaxed">
              {ollamaStatus.connected
                ? "Ask anything about your manuscript"
                : "Start Ollama to use AI features"}
            </p>
          )}
          {messages.map((msg, i) => (
            <div key={i} className="space-y-1">
              {msg.role === "user" ? (
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-background border border-border px-3 py-2 text-xs text-foreground shadow-sm whitespace-pre-wrap">
                    {msg.content}
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <div className="rounded-2xl rounded-tl-sm bg-muted px-3 py-2 text-xs text-foreground whitespace-pre-wrap">
                    {msg.content || <span className="animate-pulse text-muted-foreground">▋</span>}
                  </div>
                  {msg.content && (
                    <div className="flex gap-2 px-1">
                      <button
                        onClick={() => navigator.clipboard.writeText(msg.content)}
                        className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors font-medium"
                      >
                        Copy
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* Input area */}
      <div className="border-t border-border p-3 space-y-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          rows={3}
          placeholder={ollamaStatus.connected ? "Ask Ollama..." : "Ollama not connected..."}
          disabled={!ollamaStatus.connected}
          className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" disabled>
              <Paperclip className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" disabled>
              <Mic className="h-3.5 w-3.5" />
            </Button>
          </div>
          {loading ? (
            <Button
              size="icon"
              variant="destructive"
              className="h-7 w-7"
              onClick={() => abortRef.current?.abort()}
            >
              <StopCircle className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="h-7 w-7"
              onClick={handleSend}
              disabled={!input.trim() || !ollamaStatus.connected}
            >
              <Send className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Footer status */}
      <div className="px-4 pb-3">
        <p className="text-[10px] text-muted-foreground text-center">
          {ollamaStatus.connected ? `Running ${activeModel} • Local Inference` : "Ollama not running"}
        </p>
      </div>
    </div>
  );
}
