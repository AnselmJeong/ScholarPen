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
import { BookOpen, Bot, ChevronDown, ChevronRight, Clipboard, Copy, Globe2, MessageSquare, Plus, RotateCcw, Send, StopCircle, Trash2, X } from "lucide-react";
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
  OllamaStatus,
  ProjectInfo,
  ProjectSourcesStatus,
} from "@shared/rpc-types";
import { parseProjectFileReference, type ProjectFileReference } from "@shared/project-file-reference";
import {
  findActiveFileMention,
  replaceActiveFileMention,
} from "@shared/file-mentions";
import { createScholarAgentAdapter } from "../../ai/scholar-agent-adapter";
import {
  buildDeepenAnalysisMessage,
  extractDeepenProtectedRevision,
  formatDeepenAnalysisForDisplay,
  type DeepenAnalysisRequest,
} from "../../ai/deepen-analysis";
import {
  buildFindCitationMessage,
  type FindCitationRequest,
} from "../../ai/find-citation";
import { onProjectUpdated, rpc } from "../../rpc";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

interface AISidebarProps {
  project: ProjectInfo | null;
  ollamaStatus: OllamaStatus;
  appSettings?: Pick<AppSettings, "sidebarAgentProvider" | "sidebarAgentModel" | "ollamaBaseUrl" | "webSearchEnabled">;
  editor: BlockNoteEditor<any, any, any> | null;
  onClose: () => void;
  width?: number;
  deepenRequest?: DeepenAnalysisRequest | null;
  onDeepenRequestConsumed?: (requestId: string) => void;
  onDeepenResult?: (requestId: string, protectedRevision: string | null) => string | null;
  findCitationRequest?: FindCitationRequest | null;
  onFindCitationRequestConsumed?: (requestId: string) => void;
  onOpenProjectSource?: (reference: ProjectFileReference) => void;
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
  const mention = findActiveFileMention(value);
  if (mention) return { mode: "file", query: mention.query };
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
  onOpenProjectSource,
}: {
  message: MessageState;
  onOpenProjectSource?: (reference: ProjectFileReference) => void;
}) {
  const text = messageText(message);
  const isUser = message.role === "user";
  const isStreaming = message.status?.type === "running";
  const isError = text.trimStart().startsWith("❌") || text.includes("\n\n❌");

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
      <div
        role={isError && !isStreaming ? "alert" : undefined}
        className={cn(
          "w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm text-foreground overflow-hidden leading-relaxed prose prose-sm prose-neutral dark:prose-invert max-w-none",
          isError ? "border-destructive/60 bg-destructive/5" : "border-border",
          `
        [&_p]:my-1 [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm
        [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5
        [&_code]:text-xs [&_code]:bg-muted [&_code]:text-foreground [&_code]:px-1 [&_code]:rounded
        [&_pre]:text-xs [&_pre]:bg-muted [&_pre]:text-foreground [&_pre]:p-2 [&_pre]:rounded-md [&_pre]:overflow-x-auto
        [&_blockquote]:border-l [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:italic
        [&_hr]:border-border [&_table]:text-xs [&_th]:font-semibold [&_td]:py-0.5`,
        )}
      >
        {text ? (
          <>
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              urlTransform={(url) => url}
              components={{
                a: ({ href, children }) => {
                  return (
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        if (!href) return;
                        const projectReference = parseProjectFileReference(href);
                        if (projectReference) {
                          onOpenProjectSource?.(projectReference);
                          return;
                        }
                        rpc.openExternal(href).catch(console.error);
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
          style={{ animation: "assistant-bounce 1.2s ease-in-out infinite", animationDelay: `${j * 0.2}s` }}
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
  onOpenProjectSource,
}: {
  slashCommands: AgentSkill[];
  onOpenProjectSource?: (reference: ProjectFileReference) => void;
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
            {({ message }) => <AssistantMessage message={message} onOpenProjectSource={onOpenProjectSource} />}
          </ThreadPrimitive.Messages>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function ProjectContextBar({
  project,
  webSearchReady,
  sourceStatus,
  onRebuildSources,
}: {
  project: ProjectInfo;
  webSearchReady: boolean;
  sourceStatus: ProjectSourcesStatus | null;
  onRebuildSources: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
      <p className="text-xs text-muted-foreground truncate">
        <span className="font-medium text-foreground/80">{project.name}</span>
      </p>
      <div className="flex items-center gap-1.5">
        {sourceStatus && (sourceStatus.digestCount > 0 || sourceStatus.lastError) && (
          <button
            type="button"
            onClick={onRebuildSources}
            disabled={sourceStatus.indexing}
            title={sourceStatus.lastError
              ? `색인 오류: ${sourceStatus.lastError} · 클릭하여 다시 색인`
              : `${sourceStatus.chunkCount}개 section 색인 · 원문 PDF ${sourceStatus.linkedPdfCount}개 연결 · 클릭하여 다시 색인`}
            className="flex items-center gap-1 flex-shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
          >
            <BookOpen className="h-2.5 w-2.5" />
            {sourceStatus.lastError ? "Sources error" : `Sources ${sourceStatus.digestCount}`}
          </button>
        )}
        {webSearchReady && (
          <span
            title="OpenAlex semantic search와 PubMed를 결합하고, 부족할 때 TinyFish로 보완합니다"
            className="flex items-center gap-1 flex-shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"
          >
            <Globe2 className="h-2.5 w-2.5" />
            Web auto
          </span>
        )}
      </div>
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

function PreparedRequestDispatcher<T extends { id: string }>({
  request,
  preparedRequestId,
  ready,
  buildMessage,
  onPrepare,
  onConsumed,
}: {
  request: T | null;
  preparedRequestId: string | null;
  ready: boolean;
  buildMessage: (request: T) => string;
  onPrepare: (request: T) => void;
  onConsumed: (requestId: string) => void;
}) {
  const aui = useAui();
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const dispatchedRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!request || !ready || isRunning) return;
    if (dispatchedRequestIdRef.current === request.id) return;

    if (preparedRequestId !== request.id) {
      onPrepare(request);
      return;
    }

    dispatchedRequestIdRef.current = request.id;
    aui.composer().setText(buildMessage(request));
    queueMicrotask(() => {
      aui.composer().send();
      onConsumed(request.id);
    });
  }, [aui, buildMessage, isRunning, onConsumed, onPrepare, preparedRequestId, ready, request]);

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
  slashCommands,
  files,
  selectedSkillIds,
  selectedFilePaths,
  setSelectedSkillIds,
  setSelectedFilePaths,
  onRefreshFiles,
  projectSourcesEnabled,
  setProjectSourcesEnabled,
  sourceStatus,
}: {
  editor: BlockNoteEditor<any, any, any> | null;
  project: ProjectInfo | null;
  slashCommands: AgentSkill[];
  files: AgentMentionableFile[];
  selectedSkillIds: string[];
  selectedFilePaths: string[];
  setSelectedSkillIds: React.Dispatch<React.SetStateAction<string[]>>;
  setSelectedFilePaths: React.Dispatch<React.SetStateAction<string[]>>;
  onRefreshFiles: () => Promise<void>;
  projectSourcesEnabled: boolean;
  setProjectSourcesEnabled: (enabled: boolean) => void;
  sourceStatus: ProjectSourcesStatus | null;
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
        : [...files];
      return items
        .sort((a, b) => {
          const aStarts = a.name.toLowerCase().startsWith(dropdownQuery);
          const bStarts = b.name.toLowerCase().startsWith(dropdownQuery);
          if (aStarts && !bStarts) return -1;
          if (!aStarts && bStarts) return 1;
          return a.displayPath.localeCompare(b.displayPath);
        });
    }
    return [];
  }, [dropdownMode, dropdownQuery, slashCommands, files]);

  useEffect(() => {
    setDropdownIndex(0);
  }, [dropdownMode, dropdownQuery]);

  const previousDropdownMode = useRef<DropdownMode>(null);
  useEffect(() => {
    if (dropdownMode === "file" && previousDropdownMode.current !== "file") {
      onRefreshFiles().catch(console.error);
    }
    previousDropdownMode.current = dropdownMode;
  }, [dropdownMode, onRefreshFiles]);

  const replaceCurrentToken = useCallback(
    (replacement: string) => {
      if (dropdownMode === "slash") {
        aui.composer().setText(`${replacement} `);
        return;
      }
      aui.composer().setText(replacement);
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
        replaceCurrentToken(replaceActiveFileMention(input, file.displayPath));
        setSelectedFilePaths((prev) => (prev.includes(file.path) ? prev : [...prev, file.path]));
      }
    },
    [dropdownMode, input, replaceCurrentToken, setSelectedFilePaths, setSelectedSkillIds],
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
            {project && (sourceStatus?.digestCount ?? 0) > 0 && (
              <button
                type="button"
                disabled={loading}
                onClick={() => setProjectSourcesEnabled(!projectSourcesEnabled)}
                title="summary digest 자동 검색을 켜거나 끕니다. 원문 PDF는 필요한 질문에서만 확인합니다."
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors disabled:opacity-50",
                  projectSourcesEnabled
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground",
                )}
              >
                <BookOpen className="h-2.5 w-2.5" />
                Sources {projectSourcesEnabled ? "on" : "off"}
              </button>
            )}
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

export function AISidebar({
  project,
  ollamaStatus: _ollamaStatus,
  appSettings,
  editor,
  onClose,
  width,
  deepenRequest = null,
  onDeepenRequestConsumed,
  onDeepenResult,
  findCitationRequest = null,
  onFindCitationRequestConsumed,
  onOpenProjectSource,
}: AISidebarProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [slashCommands, setSlashCommands] = useState<AgentSkill[]>([]);
  const [mentionableFiles, setMentionableFiles] = useState<AgentMentionableFile[]>([]);
  const [threads, setThreads] = useState<AgentThread[]>([]);
  const [activeThread, setActiveThread] = useState<AgentThread | null>(null);
  const [loadedMessages, setLoadedMessages] = useState<ThreadMessageLike[]>([]);
  const [threadResetKey, setThreadResetKey] = useState("empty");
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [selectedFilePaths, setSelectedFilePaths] = useState<string[]>([]);
  const [lang, setLang] = useState<"ko" | "en">("ko");
  const [projectSourcesEnabled, setProjectSourcesEnabled] = useState(true);
  const [sourceStatus, setSourceStatus] = useState<ProjectSourcesStatus | null>(null);
  const [preparedDeepenRequestId, setPreparedDeepenRequestId] = useState<string | null>(null);
  const [preparedFindCitationRequestId, setPreparedFindCitationRequestId] = useState<string | null>(null);
  const [deepenApplyNotice, setDeepenApplyNotice] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const modelKeyRef = useRef<string | null>(null);
  const deepenRequestRef = useRef<DeepenAnalysisRequest | null>(null);
  const findCitationRequestRef = useRef<FindCitationRequest | null>(null);

  const activeProvider = appSettings?.sidebarAgentProvider ?? settings?.sidebarAgentProvider ?? "ollama";
  const activeModel =
    appSettings?.sidebarAgentModel ||
    settings?.sidebarAgentModel ||
    settings?.modelProviders?.[activeProvider]?.model ||
    settings?.ollamaDefaultModel ||
    "qwen3.5:397b";
  const modelKey = `${activeProvider}:${activeModel}`;

  const refreshThreads = useCallback(async () => {
    if (!project?.path) {
      setThreads([]);
      return;
    }
    const nextThreads = await rpc.listAgentThreads(project.path);
    setThreads(nextThreads);
  }, [project?.path]);

  const refreshMentionableFiles = useCallback(async () => {
    if (!project?.path) {
      setMentionableFiles([]);
      return;
    }
    setMentionableFiles(await rpc.listAgentMentionableFiles(project.path));
  }, [project?.path]);

  const rebuildProjectSources = useCallback(() => {
    if (!project?.path) return;
    setSourceStatus((current) => current ? { ...current, indexing: true } : current);
    rpc.rebuildProjectSourcesIndex(project.path).then(setSourceStatus).catch((error) => {
      console.error(error);
      setSourceStatus((current) => current ? { ...current, indexing: false, lastError: String(error) } : current);
    });
  }, [project?.path]);

  const startNewThread = useCallback(() => {
    setActiveThread(null);
    setLoadedMessages([]);
    setThreadResetKey(`new-${Date.now()}`);
    setSelectedSkillIds([]);
    setSelectedFilePaths([]);
    setProjectSourcesEnabled(true);
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
      const latestSourceSetting = [...data.messages].reverse().find(
        (message) => typeof message.metadata?.projectSourcesEnabled === "boolean",
      )?.metadata?.projectSourcesEnabled;
      setProjectSourcesEnabled(
        typeof latestSourceSetting === "boolean"
          ? latestSourceSetting
          : typeof data.thread.metadata?.projectSourcesEnabled === "boolean"
            ? data.thread.metadata.projectSourcesEnabled
          : true,
      );
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

  const prepareDeepenRequest = useCallback(
    (request: DeepenAnalysisRequest) => {
      findCitationRequestRef.current = null;
      deepenRequestRef.current = request;
      setDeepenApplyNotice(null);
      startNewThread();
      setPreparedDeepenRequestId(request.id);
    },
    [startNewThread],
  );

  const consumeDeepenRequest = useCallback(
    (requestId: string) => {
      setPreparedDeepenRequestId((current) => current === requestId ? null : current);
      onDeepenRequestConsumed?.(requestId);
    },
    [onDeepenRequestConsumed],
  );

  const prepareFindCitationRequest = useCallback(
    (request: FindCitationRequest) => {
      deepenRequestRef.current = null;
      findCitationRequestRef.current = request;
      startNewThread();
      setPreparedFindCitationRequestId(request.id);
    },
    [startNewThread],
  );

  const consumeFindCitationRequest = useCallback(
    (requestId: string) => {
      setPreparedFindCitationRequestId((current) => current === requestId ? null : current);
      onFindCitationRequestConsumed?.(requestId);
    },
    [onFindCitationRequestConsumed],
  );

  const assistantAdapter = useMemo(
    () =>
      createScholarAgentAdapter(async (_messages, message) => {
        const deepen = deepenRequestRef.current;
        const isDeepen =
          deepen !== null &&
          message === buildDeepenAnalysisMessage(deepen);
        if (isDeepen) deepenRequestRef.current = null;
        const findCitation = findCitationRequestRef.current;
        const isFindCitation =
          findCitation !== null &&
          message === buildFindCitationMessage(findCitation);
        if (isFindCitation) findCitationRequestRef.current = null;
        const isPreparedRequest = isDeepen || isFindCitation;
        const analysisMode = isDeepen
          ? "deepen" as const
          : isFindCitation
            ? "find-citation" as const
            : undefined;
        const fallbackSkillIds = slashCommands
          .filter((skill) => message.trimStart().startsWith(`/${skill.name}`))
          .map((skill) => skill.id);
        const skillIds = isPreparedRequest
          ? []
          : selectedSkillIds.length > 0
            ? selectedSkillIds
            : fallbackSkillIds;
        const filePaths = isPreparedRequest ? [] : selectedFilePaths;
        const projectPath = project?.path ?? null;
        const canReuseThread =
          !isPreparedRequest &&
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
            const threadTitle = isDeepen && deepen
              ? `Deepen: ${deepen.selectedText.replace(/\s+/g, " ").trim().slice(0, 72)}`
              : isFindCitation && findCitation
                ? `Find Citation: ${findCitation.selectedText.replace(/\s+/g, " ").trim().slice(0, 64)}`
                : message;
            runThread = await rpc.createAgentThread(projectPath, activeProvider, activeModel, threadTitle, {
              projectSourcesEnabled,
            });
            setActiveThread(runThread);
          }
          await rpc.saveAgentThreadMessage(projectPath, runThread.id, "user", message, "complete", {
            provider: activeProvider,
            model: activeModel,
            analysisMode,
            selectedSkillIds: skillIds,
            selectedFilePaths: filePaths,
            projectSourcesEnabled,
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
          projectSourcesEnabled,
          lang,
          analysisMode,
          deepenContext: isDeepen && deepen
            ? {
                selectedText: deepen.selectedText,
                protectedText: deepen.protection.protectedText,
                beforeSelection: deepen.documentContext.beforeSelection,
                afterSelection: deepen.documentContext.afterSelection,
              }
            : undefined,
          citationContext: isFindCitation && findCitation
            ? { selectedText: findCitation.selectedText }
            : undefined,
          ignoreHistory: isPreparedRequest || !canReuseThread,
          transformVisibleContent: isDeepen && deepen
            ? (content: string) => formatDeepenAnalysisForDisplay(content, deepen.protection)
            : undefined,
          onComplete: async (assistantMessage, status) => {
            const visibleAssistantMessage = isDeepen && deepen
              ? formatDeepenAnalysisForDisplay(assistantMessage, deepen.protection)
              : assistantMessage;

            if (isDeepen && deepen) {
              if (status === "complete") {
                try {
                  const revision = extractDeepenProtectedRevision(
                    assistantMessage,
                    deepen.protection,
                  );
                  const applyError = onDeepenResult
                    ? onDeepenResult(deepen.id, revision)
                    : "원래 편집 세션을 찾을 수 없어 문서를 변경하지 않았습니다.";
                  setDeepenApplyNotice(
                    applyError
                      ? { kind: "error", message: applyError }
                      : { kind: "success", message: "통합 개선문을 선택 영역에 반영했습니다." },
                  );
                } catch (error) {
                  onDeepenResult?.(deepen.id, null);
                  setDeepenApplyNotice({
                    kind: "error",
                    message: error instanceof Error
                      ? error.message
                      : "Deepen 결과를 안전하게 적용하지 못해 문서를 변경하지 않았습니다.",
                  });
                }
              } else {
                onDeepenResult?.(deepen.id, null);
                setDeepenApplyNotice({
                  kind: "error",
                  message: "Deepen 생성이 완료되지 않아 문서를 변경하지 않았습니다.",
                });
              }
            }

            if (!projectPath || !runThread || !visibleAssistantMessage.trim()) return;
            await rpc.saveAgentThreadMessage(projectPath, runThread.id, "assistant", visibleAssistantMessage, status, {
              provider: activeProvider,
              model: activeModel,
              analysisMode,
              selectedSkillIds: skillIds,
              selectedFilePaths: filePaths,
              projectSourcesEnabled,
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
      lang,
      projectSourcesEnabled,
      slashCommands,
      refreshThreads,
      onDeepenResult,
    ],
  );
  const assistantRuntime = useLocalRuntime(assistantAdapter);

  useEffect(() => {
    rpc.getSettings().then(setSettings).catch(console.error);
    rpc.listAgentSkills(project?.path ?? undefined).then(setSlashCommands).catch(console.error);
    startNewThread();

    if (project?.path) {
      refreshThreads().catch(console.error);
      refreshMentionableFiles().catch(console.error);
      rpc.getProjectSourcesStatus(project.path).then(setSourceStatus).catch(console.error);
    } else {
      setMentionableFiles([]);
      setThreads([]);
      setSourceStatus(null);
    }
  }, [project?.path, refreshMentionableFiles, refreshThreads, startNewThread]);

  useEffect(() => {
    if (!project?.path) return;
    return onProjectUpdated((projectPath, filePath) => {
      if (projectPath !== project.path || !filePath?.replace(/\\/g, "/").includes("/resources/articles/")) return;
      rpc.getProjectSourcesStatus(project.path).then(setSourceStatus).catch(console.error);
    });
  }, [project?.path]);

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
      <PreparedRequestDispatcher
        request={deepenRequest}
        preparedRequestId={preparedDeepenRequestId}
        ready
        buildMessage={buildDeepenAnalysisMessage}
        onPrepare={prepareDeepenRequest}
        onConsumed={consumeDeepenRequest}
      />
      <PreparedRequestDispatcher
        request={findCitationRequest}
        preparedRequestId={preparedFindCitationRequestId}
        ready
        buildMessage={buildFindCitationMessage}
        onPrepare={prepareFindCitationRequest}
        onConsumed={consumeFindCitationRequest}
      />
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
            webSearchReady={appSettings?.webSearchEnabled ?? Boolean(settings?.webSearchEnabled)}
            sourceStatus={sourceStatus}
            onRebuildSources={rebuildProjectSources}
          />
        )}

        {!activeThreadUsesCurrentModel && (
          <div className="border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            현재 선택된 model이 이 thread와 달라 다음 질문은 새 thread로 저장됩니다.
          </div>
        )}

        {deepenApplyNotice && (
          <div
            role={deepenApplyNotice.kind === "error" ? "alert" : "status"}
            className={cn(
              "border-b px-3 py-2 text-xs",
              deepenApplyNotice.kind === "error"
                ? "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                : "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            )}
          >
            {deepenApplyNotice.message}
          </div>
        )}

        <AssistantThread slashCommands={slashCommands} onOpenProjectSource={onOpenProjectSource} />

        <AssistantComposer
          editor={editor}
          project={project}
          slashCommands={slashCommands}
          files={mentionableFiles}
          selectedSkillIds={selectedSkillIds}
          selectedFilePaths={selectedFilePaths}
          setSelectedSkillIds={setSelectedSkillIds}
          setSelectedFilePaths={setSelectedFilePaths}
          onRefreshFiles={refreshMentionableFiles}
          projectSourcesEnabled={projectSourcesEnabled}
          setProjectSourcesEnabled={setProjectSourcesEnabled}
          sourceStatus={sourceStatus}
        />
      </div>
    </AssistantRuntimeProvider>
  );
}
