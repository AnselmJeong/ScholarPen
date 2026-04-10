import React, { useState, useRef, useCallback, useEffect } from "react";
import { X, RotateCcw, Copy, Send, StopCircle, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { OllamaStatus, ProjectInfo } from "@shared/rpc-types";
import type { BlockNoteEditor } from "@blocknote/core";
import { rpc, onClaudeChunk } from "../../rpc";

interface AISidebarProps {
  project: ProjectInfo | null;
  ollamaStatus: OllamaStatus; // kept for API compat — not used for chat
  editor: BlockNoteEditor<any, any, any> | null;
  onClose: () => void;
}

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

export function AISidebar({ project, editor, onClose }: AISidebarProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const abortedRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }, []);

  // Listen for streaming chunks from the Bun process
  useEffect(() => {
    return onClaudeChunk((content: string, done: boolean, newSessionId?: string) => {
      if (abortedRef.current) return;

      if (done) {
        if (newSessionId) setSessionId(newSessionId);
        setLoading(false);
        scrollToBottom();
      } else if (content) {
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === "assistant") {
            updated[updated.length - 1] = {
              role: "assistant",
              content: last.content + content,
            };
          }
          return updated;
        });
        scrollToBottom();
      }
    });
  }, [scrollToBottom]);

  const buildContextPrefix = useCallback((): string => {
    if (!editor) return "";
    const text = blocksToText(editor.document).trim();
    if (!text) return "";
    return `현재 작업 중인 문서 내용:\n\n${text}\n\n---\n\n`;
  }, [editor]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    setInput("");
    abortedRef.current = false;

    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
    setLoading(true);
    scrollToBottom();

    // Include editor context only on first turn (no session yet)
    const messageToSend = !sessionId
      ? buildContextPrefix() + userMessage
      : userMessage;

    try {
      await rpc.claudeStream(messageToSend, sessionId, project?.path ?? null);
    } catch (err) {
      if (!abortedRef.current) {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: `오류: ${(err as Error).message}`,
          };
          return updated;
        });
        setLoading(false);
      }
    }
  }, [input, loading, sessionId, project, buildContextPrefix, scrollToBottom]);

  const handleStop = useCallback(() => {
    abortedRef.current = true;
    setLoading(false);
    // Append a note to the partial message
    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last?.role === "assistant") {
        updated[updated.length - 1] = {
          role: "assistant",
          content: last.content + "\n\n*(중단됨)*",
        };
      }
      return updated;
    });
  }, []);

  const handleReset = useCallback(() => {
    setMessages([]);
    setSessionId(null);
    setLoading(false);
    abortedRef.current = false;
  }, []);

  return (
    <div className="w-72 flex-shrink-0 border-l border-border bg-background flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-primary" />
          <div>
            <p className="text-sm font-semibold text-foreground">Claude</p>
            {sessionId && (
              <p className="text-[10px] text-muted-foreground truncate w-36">
                세션 활성
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={handleReset}
            title="대화 초기화"
          >
            <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </div>
      </div>

      {/* Project context badge */}
      {project && (
        <div className="px-3 py-1.5 border-b border-border bg-muted/30">
          <p className="text-[10px] text-muted-foreground truncate">
            <span className="font-medium text-foreground">{project.name}</span>
            {" "}프로젝트 컨텍스트
          </p>
        </div>
      )}

      {/* Chat history */}
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-4">
          {messages.length === 0 && (
            <div className="mt-8 px-4 space-y-3 text-center">
              <Bot className="h-8 w-8 mx-auto text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground leading-relaxed">
                Claude에게 원고 작성, 편집, 학술 검색 등을 요청하세요.
              </p>
              <p className="text-[10px] text-muted-foreground/60">
                /skill 입력으로 특수 기능 사용 가능
              </p>
            </div>
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
                    {msg.content || (
                      <span className="animate-pulse text-muted-foreground">▋</span>
                    )}
                  </div>
                  {msg.content && (
                    <div className="flex gap-2 px-1">
                      <button
                        onClick={() => navigator.clipboard.writeText(msg.content)}
                        className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors font-medium"
                      >
                        <Copy className="h-2.5 w-2.5" />
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
          placeholder="Claude에게 질문하세요… (Shift+Enter 줄바꿈)"
          disabled={loading}
          className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        <div className="flex items-center justify-end">
          {loading ? (
            <Button
              size="icon"
              variant="destructive"
              className="h-7 w-7"
              onClick={handleStop}
              title="중단"
            >
              <StopCircle className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="h-7 w-7"
              onClick={handleSend}
              disabled={!input.trim()}
            >
              <Send className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 pb-3">
        <p className="text-[10px] text-muted-foreground text-center">
          {sessionId ? "멀티턴 대화 중 • Claude API" : "Claude Code CLI via subprocess"}
        </p>
      </div>
    </div>
  );
}
