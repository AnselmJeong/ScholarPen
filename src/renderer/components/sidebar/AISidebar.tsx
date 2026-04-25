import React, { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useLocalRuntime,
  type MessageState,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { BookOpen, Bot, ChevronDown, ChevronRight, Clipboard, Copy, MessageSquare, Plus, RotateCcw, Send, StopCircle, Trash2, X } from "lucide-react";
import type { BlockNoteEditor } from "@blocknote/core";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type {
  AgentMentionableFile,
  AgentSkill,
  AgentThread,
  AgentThreadMessage,
  AppSettings,
  KBStatus,
  OllamaStatus,
  ProjectInfo,
} from "@shared/rpc-types";
import { createScholarAgentAdapter } from "../../ai/scholar-agent-adapter";
import { rpc } from "../../rpc";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

interface AISidebarProps {
  project: ProjectInfo | null;
  ollamaStatus: OllamaStatus;
  appSettings?: Pick<AppSettings, "sidebarAgentProvider" | "sidebarAgentModel" | "ollamaBaseUrl">;
  editor: BlockNoteEditor<any, any, any> | null;
  onClose: () => void;
  width?: number;
  onOpenKBFile?: (filePath: string) => void;
}

type DropdownMode = "slash" | "file" | null;

function savedMessagesToThreadMessages(messages: AgentThreadMessage[]): ThreadMessageLike[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: new Date(message.createdAt),
    status:
      message.role === "assistant"
        ? message.status === "aborted"
          ? { type: "incomplete", reason: "cancelled" }
          : { type: "complete", reason: "stop" }
        : undefined,
    metadata: message.metadata ? { custom: message.metadata } : undefined,
  }));
}

function formatThreadTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function analyzeInput(value: string): { mode: DropdownMode; query: string } {
  if (value.startsWith("/")) return { mode: "slash", query: value.slice(1).toLowerCase() };
  const lastWord = value.split(/\s+/).at(-1) ?? "";
  if (lastWord.startsWith("@")) return { mode: "file", query: lastWord.slice(1).toLowerCase() };
  return { mode: null, query: "" };
}

function messageText(message: MessageState): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => ("text" in part ? part.text : ""))
    .join("\n");
}

function assistantLabel(provider: AppSettings["sidebarAgentProvider"]): string {
  if (provider === "anthropic") return "Claude";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "openai") return "OpenAI";
  return "Ollama";
}

function AssistantMessage({
  message,
  onOpenKBFile,
}: {
  message: MessageState;
  onOpenKBFile?: (filePath: string) => void;
}) {
  const text = messageText(message);
  const isUser = message.role === "user";
  const isStreaming = message.status?.type === "running";

  if (isUser) {
    return (
      <div className="flex justify-end w-full overflow-hidden">
        <div className="max-w-[84%] min-w-0 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground shadow-sm whitespace-pre-wrap break-words overflow-hidden">
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 w-full min-w-0 overflow-hidden">
      <div className="w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground overflow-hidden leading-relaxed prose prose-sm prose-neutral dark:prose-invert max-w-none
        [&_p]:my-1 [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm
        [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5
        [&_code]:text-xs [&_code]:bg-muted [&_code]:text-foreground [&_code]:px-1 [&_code]:rounded
        [&_pre]:text-xs [&_pre]:bg-muted [&_pre]:text-foreground [&_pre]:p-2 [&_pre]:rounded-md [&_pre]:overflow-x-auto
        [&_blockquote]:border-l [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:italic
        [&_hr]:border-border [&_table]:text-xs [&_th]:font-semibold [&_td]:py-0.5">
        {text ? (
          <>
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              urlTransform={(url) => url}
              components={{
                a: ({ href, children }) => {
                  const SP_FILE_REF = "https://x-sp-ref";
                  if (href?.startsWith(SP_FILE_REF)) {
                    const filePath = decodeURIComponent(href.slice(SP_FILE_REF.length));
                    return (
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          onOpenKBFile?.(filePath);
                        }}
                        className="cursor-pointer text-primary underline hover:text-primary/80"
                      >
                        {children}
                      </a>
                    );
                  }
                  return (
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        if (href) rpc.openExternal(href);
                      }}
                      className="cursor-pointer text-blue-400 underline hover:text-blue-300"
                    >
                      {children}
                    </a>
                  );
                },
              }}
            >
              {text}
            </ReactMarkdown>
            {isStreaming && <TypingDots />}
          </>
        ) : (
          <TypingDots />
        )}
      </div>
      {text && !isStreaming && (
        <button
          onClick={() => navigator.clipboard.writeText(text)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-1"
        >
          <Copy className="h-2.5 w-2.5" />
          복사
        </button>
      )}
    </div>
  );
}

function TypingDots() {
  return (
    <span className="flex items-center gap-1 py-1">
      {[0, 1, 2].map((j) => (
        <span
          key={j}
          className="inline-block w-1.5 h-1.5 rounded-full bg-primary/60"
          style={{ animation: "kb-bounce 1.2s ease-in-out infinite", animationDelay: `${j * 0.2}s` }}
        />
      ))}
    </span>
  );
}

function AssistantHeader({
  provider,
  model,
  lang,
  setLang,
  onClose,
  onResetContext,
}: {
  provider: AppSettings["sidebarAgentProvider"];
  model: string;
  lang: "ko" | "en";
  setLang: (lang: "ko" | "en") => void;
  onClose: () => void;
  onResetContext: () => void;
}) {
  const aui = useAui();

  return (
    <div className="flex items-center justify-between border-b border-border bg-background px-4 py-3">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-primary" />
        <div>
          <p className="text-sm font-semibold text-foreground">Scholar Assistant</p>
          <p className="text-xs text-muted-foreground">
            {assistantLabel(provider)} · {model}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className="hidden sm:inline-flex rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
          title="Scholar Assistant is read-only by default. No Claude wrapper is used."
        >
          Assistant
        </span>
        <div className="flex items-center rounded-md border border-border overflow-hidden text-[11px] font-semibold">
          {(["ko", "en"] as const).map((value) => (
            <button
              key={value}
              onClick={() => setLang(value)}
              className={cn(
                "px-2 py-0.5 transition-colors",
                lang === value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent",
              )}
            >
              {value.toUpperCase()}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => {
            aui.thread().reset();
            onResetContext();
          }}
          title="대화 초기화"
        >
          <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </div>
    </div>
  );
}

function AssistantThread({
  slashCommands,
  onOpenKBFile,
}: {
  slashCommands: AgentSkill[];
  onOpenKBFile?: (filePath: string) => void;
}) {
  return (
    <ThreadPrimitive.Root className="flex-1 min-h-0 overflow-hidden">
      <ThreadPrimitive.Viewport className="h-full overflow-y-auto bg-background p-3">
        <ThreadPrimitive.Empty>
          <div className="mt-6 px-2 space-y-3">
            <div className="text-center">
              <Bot className="h-7 w-7 mx-auto text-muted-foreground/30 mb-2" />
              <p className="text-xs text-muted-foreground leading-relaxed">Scholar Assistant가 연결되어 있습니다.</p>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-1">사용법</p>
              {[
                { prefix: "/", label: "instruction 적용  (/ + Tab으로 선택)" },
                { prefix: "@", label: "파일 지정  (@ + 파일명)" },
                { prefix: "↵", label: "전송 · Shift+↵ 줄바꿈" },
              ].map(({ prefix, label }) => (
                <div key={prefix} className="flex items-center gap-2 px-1 py-0.5">
                  <span className="text-xs font-mono bg-muted rounded px-1 text-primary w-5 text-center">{prefix}</span>
                  <span className="text-xs text-muted-foreground">{label}</span>
                </div>
              ))}
            </div>
            {slashCommands.length > 0 && (
              <p className="text-xs text-muted-foreground/60 text-center">{slashCommands.length}개 instruction 로드됨</p>
            )}
          </div>
        </ThreadPrimitive.Empty>
        <div className="space-y-4 w-full overflow-hidden">
          <ThreadPrimitive.Messages>
            {({ message }) => <AssistantMessage message={message} onOpenKBFile={onOpenKBFile} />}
          </ThreadPrimitive.Messages>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function ProjectContextBar({
  project,
  kbStatus,
}: {
  project: ProjectInfo;
  kbStatus: KBStatus | null;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
      <p className="text-xs text-muted-foreground truncate">
        <span className="font-medium text-foreground/80">{project.name}</span>
      </p>
      {kbStatus?.exists && (
        <span
          title={`KB available (${kbStatus.pageCount} pages)`}
          className="flex items-center gap-1 flex-shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
        >
          <BookOpen className="h-2.5 w-2.5" />
          {kbStatus.pageCount} KB pages
        </span>
      )}
    </div>
  );
}

function ThreadRuntimeSync({
  messages,
  resetKey,
}: {
  messages: ThreadMessageLike[];
  resetKey: string;
}) {
  const aui = useAui();

  useEffect(() => {
    aui.thread().reset(messages);
  }, [aui, messages, resetKey]);

  return null;
}

function ThreadHistoryPanel({
  threads,
  activeThreadId,
  onNewThread,
  onSelectThread,
  onDeleteThread,
}: {
  threads: AgentThread[];
  activeThreadId: string | null;
  onNewThread: () => void;
  onSelectThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
}) {
  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null;

  return (
    <div className="border-b border-border bg-background px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="h-8 min-w-0 flex-1 justify-start gap-2 px-2 text-left"
              title={activeThread?.title ?? "Thread 선택"}
            >
              <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {activeThread?.title ?? "Threads"}
              </span>
              <span className="flex-shrink-0 text-[11px] text-muted-foreground">
                {threads.length}
              </span>
              <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[min(520px,calc(100vw-2rem))] max-h-80 overflow-y-auto">
            <DropdownMenuLabel>Threads</DropdownMenuLabel>
            {threads.length === 0 ? (
              <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                저장된 thread 없음
              </DropdownMenuItem>
            ) : (
              threads.map((thread) => (
                <DropdownMenuItem
                  key={thread.id}
                  onSelect={() => onSelectThread(thread.id)}
                  className={cn(
                    "group flex items-center gap-2 rounded-md px-2 py-2",
                    activeThreadId === thread.id && "bg-primary/10",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">{thread.title}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {thread.provider} · {thread.model} · {formatThreadTime(thread.updatedAt)}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 flex-shrink-0 opacity-60 hover:opacity-100"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onDeleteThread(thread.id);
                    }}
                    title="thread 삭제"
                    type="button"
                  >
                    <Trash2 className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onNewThread} className="gap-2 text-xs">
              <Plus className="h-3.5 w-3.5" />
              새 thread
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="icon" variant="ghost" className="h-8 w-8 flex-shrink-0" onClick={onNewThread} title="새 thread">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function AssistantComposer({
  editor,
  project,
  kbStatus,
  kbEnabled,
  slashCommands,
  files,
  selectedSkillIds,
  selectedFilePaths,
  setKbEnabled,
  setSelectedSkillIds,
  setSelectedFilePaths,
}: {
  editor: BlockNoteEditor<any, any, any> | null;
  project: ProjectInfo | null;
  kbStatus: KBStatus | null;
  kbEnabled: boolean;
  slashCommands: AgentSkill[];
  files: AgentMentionableFile[];
  selectedSkillIds: string[];
  selectedFilePaths: string[];
  setKbEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedSkillIds: React.Dispatch<React.SetStateAction<string[]>>;
  setSelectedFilePaths: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  const aui = useAui();
  const input = useAuiState((s) => s.composer.text);
  const isEmpty = useAuiState((s) => s.composer.isEmpty);
  const loading = useAuiState((s) => s.thread.isRunning);
  const [dropdownIndex, setDropdownIndex] = useState(0);

  const { mode: dropdownMode, query: dropdownQuery } = useMemo(() => analyzeInput(input), [input]);

  const dropdownItems = useMemo(() => {
    if (dropdownMode === "slash") {
      const items = dropdownQuery
        ? slashCommands.filter((cmd) => cmd.name.toLowerCase().includes(dropdownQuery))
        : slashCommands;
      return items.slice(0, 30);
    }
    if (dropdownMode === "file") {
      const items = dropdownQuery
        ? files.filter((file) => file.displayPath.toLowerCase().includes(dropdownQuery) || file.name.toLowerCase().includes(dropdownQuery))
        : files;
      return items
        .sort((a, b) => {
          const aStarts = a.name.toLowerCase().startsWith(dropdownQuery);
          const bStarts = b.name.toLowerCase().startsWith(dropdownQuery);
          if (aStarts && !bStarts) return -1;
          if (!aStarts && bStarts) return 1;
          return a.displayPath.localeCompare(b.displayPath);
        })
        .slice(0, 30);
    }
    return [];
  }, [dropdownMode, dropdownQuery, slashCommands, files]);

  useEffect(() => {
    setDropdownIndex(0);
  }, [dropdownMode, dropdownQuery]);

  const replaceCurrentToken = useCallback(
    (replacement: string) => {
      if (dropdownMode === "slash") {
        aui.composer().setText(`${replacement} `);
        return;
      }
      const words = input.split(/(\s+)/);
      for (let i = words.length - 1; i >= 0; i--) {
        if (words[i].startsWith("@")) {
          words[i] = replacement;
          break;
        }
      }
      aui.composer().setText(`${words.join("")} `);
    },
    [aui, dropdownMode, input],
  );

  const selectDropdownItem = useCallback(
    (item: AgentSkill | AgentMentionableFile) => {
      if (dropdownMode === "slash") {
        const skill = item as AgentSkill;
        replaceCurrentToken(`/${skill.name}`);
        setSelectedSkillIds((prev) => (prev.includes(skill.id) ? prev : [...prev, skill.id]));
      } else if (dropdownMode === "file") {
        const file = item as AgentMentionableFile;
        replaceCurrentToken(`@${file.name}`);
        setSelectedFilePaths((prev) => (prev.includes(file.path) ? prev : [...prev, file.path]));
      }
    },
    [dropdownMode, replaceCurrentToken, setSelectedFilePaths, setSelectedSkillIds],
  );

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
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const item = dropdownItems[dropdownIndex];
          if (item) selectDropdownItem(item as AgentSkill | AgentMentionableFile);
          return;
        }
      }
    },
    [dropdownItems, dropdownIndex, dropdownMode, selectDropdownItem],
  );

  const handlePasteSelection = useCallback(() => {
    const selected = window.getSelection()?.toString().trim();
    if (!selected) return;
    aui.composer().setText(input.trim() ? `${selected}\n\n${input}` : `${selected}\n\n`);
  }, [aui, input]);

  const selectedSkills = selectedSkillIds
    .map((id) => slashCommands.find((skill) => skill.id === id))
    .filter((skill): skill is AgentSkill => Boolean(skill));
  const selectedFiles = selectedFilePaths
    .map((path) => files.find((file) => file.path === path))
    .filter((file): file is AgentMentionableFile => Boolean(file));

  return (
    <div className="relative space-y-2 border-t border-border bg-background p-3">
      {(selectedSkills.length > 0 || selectedFiles.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {selectedSkills.map((skill) => (
            <button
              key={skill.id}
              onClick={() => setSelectedSkillIds((prev) => prev.filter((id) => id !== skill.id))}
              className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[11px] text-primary hover:bg-primary/20"
            >
              /{skill.name} ×
            </button>
          ))}
          {selectedFiles.map((file) => (
            <button
              key={file.path}
              onClick={() => setSelectedFilePaths((prev) => prev.filter((path) => path !== file.path))}
              className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/80"
            >
              @{file.name} ×
            </button>
          ))}
        </div>
      )}

      {dropdownMode && dropdownItems.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 z-50 mb-1 max-h-64 overflow-y-auto rounded-md border border-border bg-popover shadow-lg">
          {dropdownMode === "slash" &&
            (dropdownItems as AgentSkill[]).map((cmd, idx) => (
              <button
                key={cmd.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectDropdownItem(cmd);
                }}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors",
                  idx === dropdownIndex && "bg-accent",
                )}
              >
                <ChevronRight className="h-3 w-3 text-primary flex-shrink-0" />
                <span className="text-sm font-mono text-primary font-medium">/{cmd.name}</span>
                <span className="text-[11px] text-muted-foreground truncate">{cmd.source}</span>
              </button>
            ))}
          {dropdownMode === "file" &&
            (dropdownItems as AgentMentionableFile[]).map((file, idx) => (
              <button
                key={file.path}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectDropdownItem(file);
                }}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors",
                  idx === dropdownIndex && "bg-accent",
                )}
              >
                <span className="text-sm font-mono text-muted-foreground flex-shrink-0">@</span>
                <span className="text-sm text-foreground truncate">{file.name}</span>
                <span className="text-[11px] text-muted-foreground truncate">{file.displayPath}</span>
              </button>
            ))}
          <div className="border-t border-border bg-muted/40 px-3 py-1.5">
            <p className="text-[11px] text-muted-foreground">↑↓ 탐색 · Enter/Tab 선택</p>
          </div>
        </div>
      )}

      <ComposerPrimitive.Root className="space-y-2">
        <ComposerPrimitive.Input
          rows={3}
          submitMode="enter"
          onKeyDown={handleKeyDown}
          placeholder={loading ? "응답 수신 중..." : "Scholar Assistant에게 질문 · / instruction · @ 파일"}
          disabled={loading}
          className="w-full resize-none rounded-md border border-input bg-muted/30 px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className={cn(
                "h-6 gap-1 rounded-full px-2 text-[11px] font-medium",
                kbStatus?.exists && kbEnabled
                  ? "bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25 hover:text-emerald-700"
                  : "text-muted-foreground hover:bg-muted",
              )}
              onClick={() => setKbEnabled((v) => !v)}
              title={
                kbStatus?.exists
                  ? kbEnabled
                    ? `이번 질문에 KB 사용 (${kbStatus.pageCount} pages)`
                    : "이번 질문에 KB 사용 안 함"
                  : "이 프로젝트에 KB가 없습니다"
              }
              disabled={loading || !kbStatus?.exists}
              type="button"
            >
              <BookOpen className="h-3 w-3" />
              KB {kbStatus?.exists && kbEnabled ? "ON" : "OFF"}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={handlePasteSelection}
              title={editor ? "선택한 텍스트 붙여넣기" : "선택한 텍스트 붙여넣기"}
              disabled={loading}
              type="button"
            >
              <Clipboard className="h-3 w-3 text-muted-foreground" />
            </Button>
            {project && <span className="text-xs text-muted-foreground">{project.name}</span>}
          </div>
          {loading ? (
            <ComposerPrimitive.Cancel asChild>
              <Button
                size="icon"
                variant="destructive"
              className="h-8 w-8"
                onClick={() => rpc.abortAgentStream().catch(console.error)}
                type="button"
              >
                <StopCircle className="h-3.5 w-3.5" />
              </Button>
            </ComposerPrimitive.Cancel>
          ) : (
            <ComposerPrimitive.Send asChild>
              <Button size="icon" className="h-8 w-8" disabled={isEmpty} type="submit">
                <Send className="h-3.5 w-3.5" />
              </Button>
            </ComposerPrimitive.Send>
          )}
        </div>
      </ComposerPrimitive.Root>
    </div>
  );
}

export function AISidebar({ project, ollamaStatus: _ollamaStatus, appSettings, editor, onClose, width, onOpenKBFile }: AISidebarProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [slashCommands, setSlashCommands] = useState<AgentSkill[]>([]);
  const [mentionableFiles, setMentionableFiles] = useState<AgentMentionableFile[]>([]);
  const [threads, setThreads] = useState<AgentThread[]>([]);
  const [activeThread, setActiveThread] = useState<AgentThread | null>(null);
  const [loadedMessages, setLoadedMessages] = useState<ThreadMessageLike[]>([]);
  const [threadResetKey, setThreadResetKey] = useState("empty");
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [selectedFilePaths, setSelectedFilePaths] = useState<string[]>([]);
  const [kbStatus, setKbStatus] = useState<KBStatus | null>(null);
  const [kbEnabled, setKbEnabled] = useState(true);
  const [lang, setLang] = useState<"ko" | "en">("ko");
  const modelKeyRef = useRef<string | null>(null);

  const activeProvider = appSettings?.sidebarAgentProvider ?? settings?.sidebarAgentProvider ?? "ollama";
  const activeModel =
    appSettings?.sidebarAgentModel ||
    settings?.sidebarAgentModel ||
    settings?.modelProviders?.[activeProvider]?.model ||
    settings?.ollamaDefaultModel ||
    "qwen3.5:cloud";
  const modelKey = `${activeProvider}:${activeModel}`;

  const refreshThreads = useCallback(async () => {
    if (!project?.path) {
      setThreads([]);
      return;
    }
    const nextThreads = await rpc.listAgentThreads(project.path);
    setThreads(nextThreads);
  }, [project?.path]);

  const startNewThread = useCallback(() => {
    setActiveThread(null);
    setLoadedMessages([]);
    setThreadResetKey(`new-${Date.now()}`);
    setSelectedSkillIds([]);
    setSelectedFilePaths([]);
  }, []);

  const loadThread = useCallback(
    async (threadId: string) => {
      if (!project?.path) return;
      const data = await rpc.getAgentThread(project.path, threadId);
      setActiveThread(data.thread);
      setLoadedMessages(savedMessagesToThreadMessages(data.messages));
      setThreadResetKey(`thread-${threadId}-${data.thread.updatedAt}`);
      setSelectedSkillIds([]);
      setSelectedFilePaths([]);
    },
    [project?.path],
  );

  const deleteThread = useCallback(
    async (threadId: string) => {
      if (!project?.path) return;
      await rpc.deleteAgentThread(project.path, threadId);
      if (activeThread?.id === threadId) startNewThread();
      await refreshThreads();
    },
    [activeThread?.id, project?.path, refreshThreads, startNewThread],
  );

  const assistantAdapter = useMemo(
    () =>
      createScholarAgentAdapter(async (_messages, message) => {
        const fallbackSkillIds = slashCommands
          .filter((skill) => message.trimStart().startsWith(`/${skill.name}`))
          .map((skill) => skill.id);
        const skillIds = selectedSkillIds.length > 0 ? selectedSkillIds : fallbackSkillIds;
        const filePaths = selectedFilePaths;
        const projectPath = project?.path ?? null;
        const canReuseThread =
          Boolean(activeThread) &&
          activeThread?.projectPath === projectPath &&
          activeThread?.provider === activeProvider &&
          activeThread?.model === activeModel;
        let runThread = canReuseThread ? activeThread : null;

        if (selectedSkillIds.length > 0 || selectedFilePaths.length > 0) {
          queueMicrotask(() => {
            setSelectedSkillIds([]);
            setSelectedFilePaths([]);
          });
        }

        if (projectPath) {
          if (!runThread) {
            runThread = await rpc.createAgentThread(projectPath, activeProvider, activeModel, message);
            setActiveThread(runThread);
          }
          await rpc.saveAgentThreadMessage(projectPath, runThread.id, "user", message, "complete", {
            provider: activeProvider,
            model: activeModel,
            kbEnabled: kbStatus?.exists ? kbEnabled : false,
            selectedSkillIds: skillIds,
            selectedFilePaths: filePaths,
            lang,
          });
          refreshThreads().catch(console.error);
        }

        return {
          projectPath,
          provider: activeProvider,
          model: activeModel,
          selectedSkillIds: skillIds,
          selectedFilePaths: filePaths,
          kbEnabled: kbStatus?.exists ? kbEnabled : false,
          lang,
          ignoreHistory: !canReuseThread,
          onComplete: async (assistantMessage, status) => {
            if (!projectPath || !runThread || !assistantMessage.trim()) return;
            await rpc.saveAgentThreadMessage(projectPath, runThread.id, "assistant", assistantMessage, status, {
              provider: activeProvider,
              model: activeModel,
              kbEnabled: kbStatus?.exists ? kbEnabled : false,
              selectedSkillIds: skillIds,
              selectedFilePaths: filePaths,
              lang,
            });
            await refreshThreads();
          },
        };
      }),
    [
      activeProvider,
      activeModel,
      activeThread,
      project?.path,
      selectedSkillIds,
      selectedFilePaths,
      kbStatus?.exists,
      kbEnabled,
      lang,
      slashCommands,
      refreshThreads,
    ],
  );
  const assistantRuntime = useLocalRuntime(assistantAdapter);

  useEffect(() => {
    rpc.getSettings().then(setSettings).catch(console.error);
    rpc.listAgentSkills(project?.path ?? undefined).then(setSlashCommands).catch(console.error);
    startNewThread();

    if (project?.path) {
      refreshThreads().catch(console.error);
      rpc.listAgentMentionableFiles(project.path).then(setMentionableFiles).catch(console.error);
      rpc.getKBStatus(project.path)
        .then((status) => {
          setKbStatus(status);
          if (status.exists) setKbEnabled(true);
        })
        .catch(console.error);
    } else {
      setKbStatus(null);
      setMentionableFiles([]);
      setThreads([]);
    }
  }, [project?.path, refreshThreads, startNewThread]);

  useEffect(() => {
    if (modelKeyRef.current === null) {
      modelKeyRef.current = modelKey;
      return;
    }
    if (modelKeyRef.current !== modelKey) {
      modelKeyRef.current = modelKey;
      startNewThread();
    }
  }, [modelKey, startNewThread]);

  const activeThreadUsesCurrentModel =
    !activeThread || (activeThread.provider === activeProvider && activeThread.model === activeModel);

  return (
    <AssistantRuntimeProvider runtime={assistantRuntime}>
      <ThreadRuntimeSync messages={loadedMessages} resetKey={threadResetKey} />
      <div
        className="relative flex h-full flex-shrink-0 flex-col border-l border-border bg-background"
        style={{
          width: width ?? 576,
        }}
      >
        <AssistantHeader
          provider={activeProvider}
          model={activeModel}
          lang={lang}
          setLang={setLang}
          onClose={onClose}
          onResetContext={startNewThread}
        />

        {project && (
          <ThreadHistoryPanel
            threads={threads}
            activeThreadId={activeThread?.id ?? null}
            onNewThread={startNewThread}
            onSelectThread={(threadId) => loadThread(threadId).catch(console.error)}
            onDeleteThread={(threadId) => deleteThread(threadId).catch(console.error)}
          />
        )}

        {project && (
          <ProjectContextBar
            project={project}
            kbStatus={kbStatus}
          />
        )}

        {!activeThreadUsesCurrentModel && (
          <div className="border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            현재 선택된 model이 이 thread와 달라 다음 질문은 새 thread로 저장됩니다.
          </div>
        )}

        <AssistantThread slashCommands={slashCommands} onOpenKBFile={onOpenKBFile} />

        <AssistantComposer
          editor={editor}
          project={project}
          kbStatus={kbStatus}
          kbEnabled={kbEnabled}
          slashCommands={slashCommands}
          files={mentionableFiles}
          selectedSkillIds={selectedSkillIds}
          selectedFilePaths={selectedFilePaths}
          setKbEnabled={setKbEnabled}
          setSelectedSkillIds={setSelectedSkillIds}
          setSelectedFilePaths={setSelectedFilePaths}
        />
      </div>
    </AssistantRuntimeProvider>
  );
}
