import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { X, RotateCcw, Copy, Send, StopCircle, Bot, ChevronRight, Clipboard, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { OllamaStatus, ProjectInfo, FileNode, KBStatus } from "@shared/rpc-types";
import type { BlockNoteEditor } from "@blocknote/core";
import { rpc, onClaudeChunk } from "../../rpc";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

interface AISidebarProps {
  project: ProjectInfo | null;
  ollamaStatus: OllamaStatus; // kept for API compat (editor AI status)
  editor: BlockNoteEditor<any, any, any> | null;
  onClose: () => void;
  width?: number;
}

interface Message {
  role: "user" | "assistant";
  content: string;
}

type DropdownMode = "slash" | "file" | null;

// ── Text extraction ───────────────────────────────────────────────────────────
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

// ── Flatten FileNode tree into a flat list ────────────────────────────────────
function flattenFiles(nodes: FileNode[]): FileNode[] {
  const result: FileNode[] = [];
  function walk(n: FileNode) {
    if (!n.isDirectory) result.push(n);
    n.children?.forEach(walk);
  }
  nodes.forEach(walk);
  return result;
}

// ── Input analysis ────────────────────────────────────────────────────────────
function analyzeInput(value: string): { mode: DropdownMode; query: string } {
  if (value.startsWith("/")) {
    return { mode: "slash", query: value.slice(1).toLowerCase() };
  }
  // detect @mention as the last word
  const lastWord = value.split(/\s+/).at(-1) ?? "";
  if (lastWord.startsWith("@")) {
    return { mode: "file", query: lastWord.slice(1).toLowerCase() };
  }
  return { mode: null, query: "" };
}

// ── Component ─────────────────────────────────────────────────────────────────
export function AISidebar({ project, editor, onClose, width }: AISidebarProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  const [fileList, setFileList] = useState<FileNode[]>([]);
  const [dropdownIndex, setDropdownIndex] = useState(0);
  const [kbStatus, setKbStatus] = useState<KBStatus | null>(null);
  const [kbEnabled, setKbEnabled] = useState(true);

  const abortedRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }, []);

  // ── Chunk listener ──────────────────────────────────────────────────────────
  useEffect(() => {
    return onClaudeChunk((
      content: string,
      done: boolean,
      newSessionId?: string,
      newSlashCommands?: string[]
    ) => {
      if (abortedRef.current && !done) return;

      // Received slash command list from system init event
      if (newSlashCommands && newSlashCommands.length > 0) {
        setSlashCommands(newSlashCommands);
        return;
      }

      if (done) {
        if (newSessionId) setSessionId(newSessionId);
        setLoading(false);
        scrollToBottom();
        return;
      }

      if (content) {
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated.at(-1);
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

  // ── Pre-fetch slash commands and KB status whenever the project changes ─────
  useEffect(() => {
    rpc.getClaudeSlashCommands(project?.path ?? undefined)
      .then((cmds) => { if (cmds.length > 0) setSlashCommands(cmds); })
      .catch(console.error);

    if (project?.path) {
      rpc.getKBStatus(project.path)
        .then((status) => {
          setKbStatus(status);
          // Auto-enable KB when it exists
          if (status.exists) setKbEnabled(true);
        })
        .catch(console.error);
    } else {
      setKbStatus(null);
    }
  }, [project?.path]);

  // ── Dropdown computation ────────────────────────────────────────────────────
  const { mode: dropdownMode, query: dropdownQuery } = useMemo(
    () => analyzeInput(input),
    [input]
  );

  const dropdownItems = useMemo(() => {
    if (dropdownMode === "slash") {
      if (!dropdownQuery) return slashCommands.slice(0, 20);
      return slashCommands
        .filter((cmd) => cmd.toLowerCase().includes(dropdownQuery))
        .slice(0, 30);
    }
    if (dropdownMode === "file") {
      const flat = flattenFiles(fileList);
      if (!dropdownQuery) return flat.slice(0, 8);
      return flat
        .filter((f) => f.name.toLowerCase().includes(dropdownQuery))
        .slice(0, 8);
    }
    return [];
  }, [dropdownMode, dropdownQuery, slashCommands, fileList]);

  // Load file list when @ is triggered and not yet loaded
  useEffect(() => {
    if (dropdownMode === "file" && project && fileList.length === 0) {
      rpc.listProjectFiles(project.path).then(setFileList).catch(console.error);
    }
  }, [dropdownMode, project, fileList.length]);

  // Reset dropdown index when items change
  useEffect(() => {
    setDropdownIndex(0);
  }, [dropdownMode, dropdownQuery]);

  // ── Dropdown selection ──────────────────────────────────────────────────────
  const selectDropdownItem = useCallback(
    (item: string | FileNode) => {
      if (dropdownMode === "slash") {
        setInput("/" + (item as string) + " ");
      } else if (dropdownMode === "file") {
        const file = item as FileNode;
        const words = input.split(/(\s+)/);
        // Replace the last @-word with the file name
        for (let i = words.length - 1; i >= 0; i--) {
          if (words[i].startsWith("@")) {
            words[i] = "@" + file.name;
            break;
          }
        }
        setInput(words.join("") + " ");
      }
      setTimeout(() => textareaRef.current?.focus(), 0);
    },
    [dropdownMode, input]
  );

  // ── Send ────────────────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    setInput("");
    abortedRef.current = false;

    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
    setLoading(true);
    scrollToBottom();

    try {
      await rpc.claudeStream(
        userMessage,
        sessionId,
        project?.path ?? null,
        kbStatus?.exists ? kbEnabled : false
      );
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
  }, [input, loading, sessionId, project, scrollToBottom, kbStatus, kbEnabled]);

  const handleStop = useCallback(() => {
    abortedRef.current = true;
    setLoading(false);
    setMessages((prev) => {
      const updated = [...prev];
      const last = updated.at(-1);
      if (last?.role === "assistant" && last.content) {
        updated[updated.length - 1] = {
          ...last,
          content: last.content + "\n\n*(중단됨)*",
        };
      }
      return updated;
    });
  }, []);

  const handlePasteSelection = useCallback(() => {
    const selected = window.getSelection()?.toString().trim();
    if (!selected) return;
    setInput((prev) => {
      const base = prev.trim() ? selected + "\n\n" + prev : selected + "\n\n";
      return base;
    });
    setTimeout(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    }, 0);
  }, []);

  const handleReset = useCallback(() => {
    setMessages([]);
    setSessionId(null);
    setLoading(false);
    abortedRef.current = false;
  }, []);

  // ── Keyboard handling ───────────────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (dropdownItems.length > 0 && dropdownMode) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setDropdownIndex((i) => Math.min(i + 1, dropdownItems.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setDropdownIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const item = dropdownItems[dropdownIndex];
          if (item) selectDropdownItem(item);
          return;
        }
        if (e.key === "Escape") {
          setInput("");
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          const item = dropdownItems[dropdownIndex];
          if (item) selectDropdownItem(item);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [dropdownMode, dropdownItems, dropdownIndex, selectDropdownItem, handleSend]
  );

  const handleInputChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div
      className="flex-shrink-0 border-l border-border bg-background flex flex-col h-full relative"
      style={{ width: width ?? 576 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-primary" />
          <div>
            <p className="text-sm font-semibold text-foreground">Claude</p>
            {sessionId && (
              <p className="text-xs text-emerald-500">세션 활성</p>
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

      {/* Project context badge + KB toggle */}
      {project && (
        <div className="px-3 py-1.5 border-b border-border bg-muted/30 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground truncate">
            <span className="font-medium text-foreground/80">{project.name}</span>
          </p>
          {kbStatus?.exists && (
            <button
              onClick={() => setKbEnabled((v) => !v)}
              title={
                kbEnabled
                  ? `KB 활성 (${kbStatus.pageCount}개 페이지) — 클릭하여 비활성화`
                  : "KB 비활성 — 클릭하여 활성화"
              }
              className={cn(
                "flex items-center gap-1 flex-shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium transition-colors",
                kbEnabled
                  ? "bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              )}
            >
              <BookOpen className="h-2.5 w-2.5" />
              KB {kbEnabled ? "ON" : "OFF"}
            </button>
          )}
        </div>
      )}

      {/* Chat history */}
      <ScrollArea className="flex-1 overflow-hidden">
        <div className="p-3 space-y-4 w-full overflow-hidden">
          {messages.length === 0 && (
            <div className="mt-6 px-2 space-y-3">
              <div className="text-center">
                <Bot className="h-7 w-7 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Claude Code가 연결되어 있습니다.
                </p>
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-1">사용법</p>
                {[
                  { prefix: "/", label: "skill 실행  (/ + Tab으로 선택)" },
                  { prefix: "@", label: "파일 멘션  (@ + 파일명)" },
                  { prefix: "↵", label: "전송 · Shift+↵ 줄바꿈" },
                ].map(({ prefix, label }) => (
                  <div key={prefix} className="flex items-center gap-2 px-1 py-0.5">
                    <span className="text-xs font-mono bg-muted rounded px-1 text-primary w-5 text-center">{prefix}</span>
                    <span className="text-xs text-muted-foreground">{label}</span>
                  </div>
                ))}
              </div>
              {slashCommands.length > 0 && (
                <p className="text-xs text-muted-foreground/60 text-center">
                  {slashCommands.length}개 skill 로드됨
                </p>
              )}
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className="space-y-1 w-full min-w-0 overflow-hidden">
              {msg.role === "user" ? (
                <div className="flex justify-end w-full overflow-hidden">
                  <div className="max-w-[88%] min-w-0 rounded-2xl rounded-tr-sm bg-primary/10 border border-primary/20 px-3 py-2 text-sm text-foreground shadow-sm whitespace-pre-wrap break-all overflow-hidden">
                    {msg.content}
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5 w-full min-w-0 overflow-hidden">
                  <div className="w-full min-w-0 rounded-2xl rounded-tl-sm bg-muted px-3 py-2 text-sm text-foreground overflow-hidden leading-relaxed prose prose-sm prose-neutral dark:prose-invert max-w-none
                    [&_p]:my-1 [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm
                    [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5
                    [&_code]:text-xs [&_code]:bg-background/60 [&_code]:px-1 [&_code]:rounded
                    [&_pre]:text-xs [&_pre]:bg-background/60 [&_pre]:p-2 [&_pre]:rounded [&_pre]:overflow-x-auto
                    [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-2 [&_blockquote]:italic
                    [&_hr]:border-border [&_table]:text-xs [&_th]:font-semibold [&_td]:py-0.5">
                    {msg.content ? (
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[rehypeKatex]}
                      >
                        {msg.content}
                      </ReactMarkdown>
                    ) : (
                      <span className="flex items-center gap-1 py-1">
                        {[0, 1, 2].map((i) => (
                          <span
                            key={i}
                            className="inline-block w-1.5 h-1.5 rounded-full bg-primary/60"
                            style={{
                              animation: "kb-bounce 1.2s ease-in-out infinite",
                              animationDelay: `${i * 0.2}s`,
                            }}
                          />
                        ))}
                      </span>
                    )}
                  </div>
                  {msg.content && (
                    <button
                      onClick={() => navigator.clipboard.writeText(msg.content)}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-1"
                    >
                      <Copy className="h-2.5 w-2.5" />
                      복사
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* Input area */}
      <div className="border-t border-border p-3 space-y-2 relative">
        {/* Dropdown — positioned above input */}
        {dropdownMode && dropdownItems.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 mb-1 bg-popover border border-border rounded-lg shadow-lg overflow-hidden z-50 max-h-64 overflow-y-auto">
            {/* Slash commands */}
            {dropdownMode === "slash" &&
              (dropdownItems as string[]).map((cmd, idx) => (
                <button
                  key={cmd}
                  onMouseDown={(e) => { e.preventDefault(); selectDropdownItem(cmd); }}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors",
                    idx === dropdownIndex && "bg-accent"
                  )}
                >
                  <ChevronRight className="h-3 w-3 text-primary flex-shrink-0" />
                  <span className="text-sm font-mono text-primary font-medium">/{cmd}</span>
                </button>
              ))}

            {/* File list */}
            {dropdownMode === "file" &&
              (dropdownItems as FileNode[]).map((file, idx) => (
                <button
                  key={file.path}
                  onMouseDown={(e) => { e.preventDefault(); selectDropdownItem(file); }}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors",
                    idx === dropdownIndex && "bg-accent"
                  )}
                >
                  <span className="text-sm font-mono text-muted-foreground flex-shrink-0">@</span>
                  <span className="text-sm text-foreground truncate">{file.name}</span>
                </button>
              ))}

            {/* Hint */}
            <div className="px-3 py-1.5 border-t border-border bg-muted/30">
              <p className="text-[11px] text-muted-foreground">
                ↑↓ 탐색 · Enter/Tab 선택 · Esc 닫기
              </p>
            </div>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          rows={3}
          placeholder={loading ? "응답 수신 중…" : "Claude에게 질문 · / skill · @ 파일"}
          disabled={loading}
          className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={handlePasteSelection}
              title="선택한 텍스트 붙여넣기"
              disabled={loading}
            >
              <Clipboard className="h-3 w-3 text-muted-foreground" />
            </Button>
            {dropdownMode === "slash" && slashCommands.length > 0 && (
              <span className="text-xs text-muted-foreground">{slashCommands.length} skills</span>
            )}
          </div>
          {loading ? (
            <Button size="icon" variant="destructive" className="h-7 w-7" onClick={handleStop}>
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

    </div>
  );
}
