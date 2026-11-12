import { AIDetectorSetup } from "../../../plugins/ai-writing-score/ui/AIDetectorSetup";
import { imageAttachmentAdapter, imagesFromMessage, restoredImageAttachments } from "../../ai/image-attachments";
import { IMAGE_ACCEPT, MAX_MESSAGE_IMAGES } from "@shared/agent-images";
import React, { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  ComposerPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useLocalRuntime,
  type MessageState,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { BookOpen, Bot, Check, ChevronDown, ChevronRight, Clipboard, Copy, Globe2, MessageSquare, Paperclip, Plus, RotateCcw, Send, StopCircle, Trash2, X } from "lucide-react";
import type { BlockNoteEditor } from "@blocknote/core";
import { DropdownMenu as AstryxDropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Kbd } from "@astryxdesign/core/Kbd";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { Token } from "@astryxdesign/core/Token";
import { cn } from "@/lib/utils";
import type {
  ActiveDocumentContext,
  AgentMentionableFile,
  AgentSkill,
  AgentThread,
  AgentThreadMessage,
  AgentThinkingLevel,
  AppSettings,
  OllamaStatus,
  ProjectInfo,
  ProjectSourcesStatus,
} from "@shared/rpc-types";
import { AGENT_THINKING_LEVELS, agentThinkingConfig } from "@shared/agent-thinking";
import { parseProjectFileReference, type ProjectFileReference } from "@shared/project-file-reference";
import {
  findActiveFileMention,
  replaceActiveFileMention,
} from "@shared/file-mentions";
import { createScholarAgentAdapter } from "../../ai/scholar-agent-adapter";
import type { AIResponsePreferences } from "../../hooks/useAIResponsePreferences";
import { applySelectionReviewResult, type SelectionReviewNotice } from "../../ai/selection-review-result";
import {
  buildDeepenAnalysisMessage,
  formatDeepenAnalysisForDisplay,
  type DeepenAnalysisRequest,
} from "../../ai/deepen-analysis";
import {
  buildFindCitationMessage,
  createFindCitationRequest,
  type FindCitationRequest,
} from "../../ai/find-citation";
import { buildCitationCheckMessage, type CitationCheckRequest } from "../../ai/check-citations";
import { onProjectUpdated, rpc } from "../../rpc";
import ReactMarkdown from "react-markdown";
import { AIDetectionResult } from "../../../plugins/ai-writing-score/ui/AIDetectionResult";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { ProjectMemoryPanel } from "./ProjectMemoryPanel";
import { CitationEvidenceResults } from "./CitationEvidenceResults";
import { CitationCheckResults } from "./CitationCheckResults";
import { CITATION_CHECK_MARKER, citationCheckResultText, parseCitationCheckResult } from "@shared/citation-check";
import { CITATION_RESULT_MARKER, citationResultText, parseCitationSearchResult } from "@shared/citation-evidence";
import { asksForAIScore, detectionTextFromBlocks, supersededDetectionMessages } from "@shared/ai-detection";

interface AISidebarProps {
  responsePreferences: AIResponsePreferences;
  onSearchEnabledChange: (enabled: boolean) => void;
  onThinkingLevelChange: (level: AgentThinkingLevel) => void;
  project: ProjectInfo | null;
  ollamaStatus: OllamaStatus;
  appSettings?: Pick<AppSettings, "sidebarAgentProvider" | "sidebarAgentModel" | "ollamaBaseUrl" | "webSearchEnabled">;
  editor: BlockNoteEditor<any, any, any> | null;
  activeDocumentName?: string | null;
  getActiveDocumentContext?: () => ActiveDocumentContext | undefined;
  onClose: () => void;
  width?: number;
  deepenRequest?: DeepenAnalysisRequest | null;
  onDeepenRequestConsumed?: (requestId: string) => void;
  onDeepenResult?: (requestId: string, protectedRevision: string | null) => string | null;
  findCitationRequest?: FindCitationRequest | null;
  onFindCitationRequestConsumed?: (requestId: string) => void;
  citationCheckRequest?: CitationCheckRequest | null;
  onCitationCheckRequestConsumed?: (requestId: string) => void;
  /** Stages a citation check's revision as a tracked change; returns an error message. */
  onApplyCitationRevision?: (requestId: string, protectedRevision: string) => string | null;
  onOpenProjectSource?: (reference: ProjectFileReference) => void;
}

type DropdownMode = "slash" | "file" | null;

function savedMessagesToThreadMessages(messages: AgentThreadMessage[]): ThreadMessageLike[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: new Date(message.createdAt),
    attachments: message.role === "user" ? restoredImageAttachments(message.metadata?.images) : undefined,
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
  if (provider === "anthropic") return "Claude · 구독";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "openai") return "OpenAI";
  if (provider === "codex") return "Codex · ChatGPT 구독";
  return "Ollama";
}

function AssistantMessage({
  onOpenProjectSource,
  projectPath,
  onRetryCitation,
  onApplyCitationRevision,
}: {
  onOpenProjectSource?: (reference: ProjectFileReference) => void;
  projectPath: string | null;
  onRetryCitation: (claims: string[], selectedText: string) => void;
  onApplyCitationRevision?: (requestId: string, protectedRevision: string) => string | null;
}) {
  const message = useAuiState((state) => state.message);
  const text = messageText(message);
  const isUser = message.role === "user";
  const isStreaming = message.status?.type === "running";
  const isError = text.trimStart().startsWith("❌") || text.includes("\n\n❌");
  const citationResult = !isUser ? parseCitationSearchResult(text) : null;
  const citationCheck = !isUser ? parseCitationCheckResult(text) : null;
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const superseded = useAuiState(state => supersededDetectionMessages(state.thread.messages.map(item => ({
    id: item.id, role: item.role,
    text: item.content.filter(part => part.type === "text").map(part => "text" in part ? part.text : "").join("\n"),
  }))).has(message.id));

  if (superseded) return null;

  if (isUser) {
    const images = imagesFromMessage(message);
    return (
      <div className="flex justify-end w-full overflow-hidden">
        <div className="max-w-[84%] min-w-0 overflow-hidden whitespace-pre-wrap break-words rounded-lg rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
          {images.length > 0 && <div className="mb-2 flex flex-wrap gap-2">
            {images.map((image, index) => <img key={index} src={image.dataUrl} alt={image.name} title={image.name} className="max-h-48 max-w-full rounded border border-primary-foreground/20 object-contain" />)}
          </div>}
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
          "w-full min-w-0 overflow-hidden rounded-lg rounded-bl-sm border px-3 py-2 text-sm leading-relaxed text-foreground prose prose-sm prose-neutral dark:prose-invert max-w-none",
          isError ? "border-destructive/60 bg-destructive/5" : "border-sidebar-border bg-card",
          `
        [&_p]:my-1 [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm
        [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5
        [&_code]:text-xs [&_code]:bg-muted [&_code]:text-foreground [&_code]:px-1 [&_code]:rounded
        [&_pre]:text-xs [&_pre]:bg-muted [&_pre]:text-foreground [&_pre]:p-2 [&_pre]:rounded-md [&_pre]:overflow-x-auto
        [&_blockquote]:border-l [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:italic
        [&_hr]:border-border [&_table]:text-xs [&_th]:font-semibold [&_td]:py-0.5`,
        )}
      >
        {citationResult ? (
          <CitationEvidenceResults result={citationResult} projectPath={projectPath} onRetry={onRetryCitation} busy={isRunning} />
        ) : citationCheck ? (
          <CitationCheckResults result={citationCheck} onOpenProjectSource={onOpenProjectSource} onApplyRevision={onApplyCitationRevision} />
        ) : text.includes("**DetectorScope ·") ? (
          <AIDetectionResult text={text.slice(text.indexOf("**DetectorScope ·"))} />
        ) : text ? (
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
                      className="cursor-pointer text-primary underline underline-offset-2 hover:opacity-80"
                    >
                      {children}
                    </a>
                  );
                },
              }}
            >
              {text.includes(CITATION_RESULT_MARKER) ? "인용 근거를 불러오는 중…" : text.includes(CITATION_CHECK_MARKER) ? "인용 확인 결과를 불러오는 중…" : text}
            </ReactMarkdown>
            {isStreaming && <TypingDots />}
          </>
        ) : (
          <TypingDots />
        )}
      </div>
      {text && !isStreaming && (
        <AstryxButton label="복사" size="sm" variant="ghost" icon={<Copy className="h-3 w-3" aria-hidden />}
          onClick={() => void navigator.clipboard.writeText(citationResult ? citationResultText(citationResult) : citationCheck ? citationCheckResultText(citationCheck) : text)} />
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
    <div className="flex items-center gap-2 border-b border-sidebar-border px-3 py-2">
      <Bot className="h-4 w-4 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <Text type="label" weight="semibold" display="block">Scholar Assistant</Text>
        <Text type="supporting" display="block" maxLines={1}>{assistantLabel(provider)} · {model || "기본 모델"}</Text>
      </div>
      <span title="Scholar Assistant is read-only by default. No Claude wrapper is used.">
        <Badge label="Assistant" />
      </span>
      <SegmentedControl label="Response language" size="sm" value={lang} onChange={(value) => setLang(value as "ko" | "en")}>
        <SegmentedControlItem value="ko" label="KO" />
        <SegmentedControlItem value="en" label="EN" />
      </SegmentedControl>
      <AstryxButton label="대화 초기화" tooltip="대화 초기화" variant="ghost" size="sm" isIconOnly
        icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden />}
        onClick={() => {
          aui.thread().reset();
          onResetContext();
        }} />
    </div>
  );
}

function AssistantThread({
  slashCommands,
  onOpenProjectSource,
  projectPath,
  onRetryCitation,
  onApplyCitationRevision,
}: {
  slashCommands: AgentSkill[];
  onOpenProjectSource?: (reference: ProjectFileReference) => void;
  projectPath: string | null;
  onRetryCitation: (claims: string[], selectedText: string) => void;
  onApplyCitationRevision?: (requestId: string, protectedRevision: string) => string | null;
}) {
  return (
    <ThreadPrimitive.Root className="flex-1 min-h-0 overflow-hidden">
      <ThreadPrimitive.Viewport className="h-full overflow-y-auto p-3">
        <ThreadPrimitive.Empty>
          <div className="mt-6 space-y-4 px-2">
            <div className="space-y-2 text-center">
              <Bot className="mx-auto h-7 w-7 text-muted-foreground/40" aria-hidden />
              <Text type="supporting" display="block">Scholar Assistant가 연결되어 있습니다.</Text>
            </div>
            <div className="space-y-1.5">
              <p className="workbench-section-label px-1">사용법</p>
              {[
                { keys: "/", label: "instruction 적용  (/ + Tab으로 선택)" },
                { keys: "@", label: "파일 지정  (@ + 파일명)" },
                { keys: "enter", label: "전송 · Shift+↵ 줄바꿈" },
              ].map(({ keys, label }) => (
                <div key={keys} className="flex items-center gap-2 px-1 py-0.5">
                  <span className="w-12 shrink-0"><Kbd keys={keys} /></span>
                  <Text type="supporting">{label}</Text>
                </div>
              ))}
            </div>
            {slashCommands.length > 0 && (
              <Text type="supporting" display="block" justify="center">{slashCommands.length}개 instruction 로드됨</Text>
            )}
          </div>
        </ThreadPrimitive.Empty>
        <div className="space-y-4 w-full overflow-hidden">
          <ThreadPrimitive.Messages>
            {() => <AssistantMessage onOpenProjectSource={onOpenProjectSource} projectPath={projectPath} onRetryCitation={onRetryCitation} onApplyCitationRevision={onApplyCitationRevision} />}
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
    <div className="flex items-center justify-between gap-2 border-b border-sidebar-border px-3 py-1.5">
      <Text type="supporting" maxLines={1}>
        <span className="font-medium text-foreground/80">{project.name}</span>
      </Text>
      <div className="flex items-center gap-1.5">
        {sourceStatus && (sourceStatus.digestCount > 0 || sourceStatus.lastError) && (
          <AstryxButton size="sm" variant="ghost" isDisabled={sourceStatus.indexing} isLoading={sourceStatus.indexing}
            tooltip={sourceStatus.lastError
              ? `색인 오류: ${sourceStatus.lastError} · 클릭하여 다시 색인`
              : `${sourceStatus.chunkCount}개 section 색인 · 원문 PDF ${sourceStatus.linkedPdfCount}개 연결 · 클릭하여 다시 색인`}
            icon={<BookOpen className="h-3 w-3" aria-hidden />}
            label={sourceStatus.lastError ? "Sources error" : `Sources ${sourceStatus.digestCount}`}
            onClick={onRebuildSources} />
        )}
        {webSearchReady && (
          <span title="OpenAlex semantic search와 PubMed를 결합하고, 부족할 때 TinyFish로 보완합니다">
            <Badge variant="success" icon={<Globe2 className="h-3 w-3" aria-hidden />} label="Search available" />
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
    <div className="border-b border-sidebar-border px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <AstryxDropdownMenu
            menuWidth="min(520px, calc(100vw - 2rem))"
            menuMaxHeight={360}
            items={[
              {
                type: "section" as const,
                title: "Threads",
                items: threads.length === 0
                  ? [{ label: "저장된 thread 없음", isDisabled: true }]
                  : threads.map((thread) => ({
                    label: thread.title,
                    description: `${thread.provider} · ${thread.model} · ${formatThreadTime(thread.updatedAt)}`,
                    endContent: activeThreadId === thread.id ? <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" /> : undefined,
                    onClick: () => onSelectThread(thread.id),
                  })),
              },
              { type: "divider" as const },
              { label: "새 thread", icon: Plus, onClick: onNewThread },
              ...(threads.length > 0 ? [{
                label: "Thread 삭제",
                icon: Trash2,
                items: threads.map((thread) => ({
                  label: thread.title,
                  variant: "destructive" as const,
                  onClick: () => onDeleteThread(thread.id),
                })),
              }] : []),
            ]}
            renderTrigger={(trigger) => (
              <button {...trigger} type="button" title={activeThread?.title ?? "Thread 선택"}
                className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
                <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {activeThread?.title ?? "Threads"}
                </span>
                <span className="flex-shrink-0 font-mono-ui text-[11px] text-muted-foreground">
                  {threads.length}
                </span>
                <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
              </button>
            )}
          />
        </div>
        <AstryxButton label="새 thread" tooltip="새 thread" variant="ghost" size="sm" isIconOnly
          icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />} onClick={onNewThread} />
      </div>
    </div>
  );
}

function ComposerImageAttachment() {
  const attachment = useAuiState((s) => s.attachment);
  const image = attachment.content?.find((part) => part.type === "image");
  const failed = attachment.status.type === "incomplete";
  return (
    <AttachmentPrimitive.Root className="relative flex w-28 flex-col gap-1 rounded-md border border-sidebar-border bg-background p-2">
      {image?.type === "image" && <img src={image.image} alt={attachment.name} className="h-16 w-full rounded object-contain" />}
      <span className="truncate text-[11px]" title={attachment.name}>{attachment.name}</span>
      {failed && <span role="alert" className="text-[10px] text-destructive">이미지 읽기 실패 · 지원 형식과 5 MB 제한을 확인하세요.</span>}
      {attachment.status.type === "running" && <span className="text-[10px]">이미지 준비 중…</span>}
      <AttachmentPrimitive.Remove aria-label="첨부 이미지 제거" className="absolute -right-1.5 -top-1.5 rounded-full border border-sidebar-border bg-background p-0.5 text-muted-foreground hover:text-foreground"><X className="h-3 w-3" aria-hidden /></AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
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
  searchEnabled,
  setSearchEnabled,
  searchAvailable,
  thinkingLevel,
  setThinkingLevel,
  provider,
  model,
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
  searchEnabled: boolean;
  setSearchEnabled: (enabled: boolean) => void;
  searchAvailable: boolean;
  thinkingLevel: AgentThinkingLevel;
  setThinkingLevel: (level: AgentThinkingLevel) => void;
  provider: AppSettings["sidebarAgentProvider"];
  model: string;
}) {
  const aui = useAui();
  const input = useAuiState((s) => s.composer.text);
  const isEmpty = useAuiState((s) => s.composer.isEmpty);
  const attachments = useAuiState((s) => s.composer.attachments);
  const attachmentsBlocked = attachments.length > MAX_MESSAGE_IMAGES || attachments.some((item) => item.status.type === "incomplete" || item.status.type === "running");
  const loading = useAuiState((s) => s.thread.isRunning);
  const [dropdownIndex, setDropdownIndex] = useState(0);
  const thinkingConfig = agentThinkingConfig(provider, model, thinkingLevel);

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

  const fileInput = useRef<HTMLInputElement>(null);
  const addFiles = (list: FileList | null) => {
    for (const file of Array.from(list ?? [])) void aui.composer().addAttachment(file).catch(console.error);
    if (fileInput.current) fileInput.current.value = "";
  };

  return (
    <div className="relative space-y-2 border-t border-sidebar-border p-3">
      {(selectedSkills.length > 0 || selectedFiles.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {selectedSkills.map((skill) => (
            <Token key={skill.id} size="sm" color="blue" label={`/${skill.name}`}
              onRemove={() => setSelectedSkillIds((prev) => prev.filter((id) => id !== skill.id))} />
          ))}
          {selectedFiles.map((file) => (
            <Token key={file.path} size="sm" label={`@${file.name}`}
              onRemove={() => setSelectedFilePaths((prev) => prev.filter((path) => path !== file.path))} />
          ))}
        </div>
      )}

      {dropdownMode && dropdownItems.length > 0 && (
        <div role="listbox" aria-label={dropdownMode === "slash" ? "Instructions" : "Project files"}
          className="absolute bottom-full left-3 right-3 z-50 mb-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-lg">
          {dropdownMode === "slash" &&
            (dropdownItems as AgentSkill[]).map((cmd, idx) => (
              <button
                key={cmd.id}
                role="option"
                aria-selected={idx === dropdownIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectDropdownItem(cmd);
                }}
                className={cn(
                  "mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent",
                  idx === dropdownIndex && "bg-accent",
                )}
              >
                <ChevronRight className="h-3 w-3 shrink-0 text-primary" aria-hidden />
                <span className="font-mono-ui text-xs font-medium text-primary">/{cmd.name}</span>
                <span className="truncate text-[11px] text-muted-foreground">{cmd.source}</span>
              </button>
            ))}
          {dropdownMode === "file" &&
            (dropdownItems as AgentMentionableFile[]).map((file, idx) => (
              <button
                key={file.path}
                role="option"
                aria-selected={idx === dropdownIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectDropdownItem(file);
                }}
                className={cn(
                  "mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent",
                  idx === dropdownIndex && "bg-accent",
                )}
              >
                <span className="shrink-0 font-mono-ui text-xs text-muted-foreground">@</span>
                <span className="truncate text-xs text-foreground">{file.name}</span>
                <span className="truncate text-[11px] text-muted-foreground">{file.displayPath}</span>
              </button>
            ))}
          <div className="mt-1 flex items-center gap-2 border-t border-border px-3 pt-1.5">
            <Kbd keys="up" /><Kbd keys="down" /><Text type="supporting">탐색</Text>
            <Kbd keys="enter" /><Kbd keys="tab" /><Text type="supporting">선택</Text>
          </div>
        </div>
      )}

      <ComposerPrimitive.Root className="space-y-2" onSubmitCapture={(event) => {
        if (attachmentsBlocked) { event.preventDefault(); event.stopPropagation(); }
      }}>
        <div className="flex flex-wrap gap-2"><ComposerPrimitive.Attachments components={{ Attachment: ComposerImageAttachment }} /></div>
        {attachments.length > MAX_MESSAGE_IMAGES && <p role="alert" className="text-xs text-destructive">이미지는 한 질문에 최대 {MAX_MESSAGE_IMAGES}개까지 첨부할 수 있습니다. 초과 이미지를 제거해 주세요.</p>}
        <ComposerPrimitive.Input
          rows={3}
          submitMode="enter"
          aria-label="Assistant message"
          onKeyDown={(event) => {
            if (attachmentsBlocked && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); return; }
            handleKeyDown(event);
          }}
          placeholder={loading ? "응답 수신 중..." : "질문 또는 이미지 붙여넣기 · / instruction · @ 파일"}
          disabled={loading}
          className="composer-input w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
        />
        <div className="flex flex-wrap items-center gap-2">
          <ToggleButton size="sm" label={`Search ${searchEnabled && searchAvailable ? "on" : "off"}`} aria-label="웹 검색 사용"
            isPressed={searchEnabled && searchAvailable} isDisabled={loading || !searchAvailable}
            tooltip={searchAvailable ? "다시 변경할 때까지 새 대화에도 이 검색 설정을 사용합니다" : "Settings에서 Web search를 먼저 켜세요"}
            icon={<Globe2 className="h-3 w-3" aria-hidden />} onPressedChange={() => setSearchEnabled(!searchEnabled)}>
            Search {searchEnabled && searchAvailable ? "on" : "off"}
          </ToggleButton>
          <div className="flex items-center gap-1.5">
            <Text type="supporting">Thinking</Text>
            <div className="w-28">
              <Selector label="Thinking 수준" isLabelHidden size="sm" value={thinkingLevel}
                isDisabled={loading || thinkingConfig.supported === false}
                options={AGENT_THINKING_LEVELS.map((level) => ({ value: level, label: level === "none" ? "None" : level[0].toUpperCase() + level.slice(1) }))}
                onChange={(value) => { if (value) setThinkingLevel(value as AgentThinkingLevel); }} />
            </div>
          </div>
          <Text type="supporting">변경 전까지 새 대화에도 유지</Text>
        </div>
        {thinkingConfig.notice && <Text type="supporting" display="block">{thinkingConfig.notice}</Text>}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <input ref={fileInput} type="file" multiple hidden accept={IMAGE_ACCEPT}
              onChange={(event) => addFiles(event.currentTarget.files)} />
            <AstryxButton label="이미지 파일 첨부" tooltip="이미지 첨부 · PNG, JPEG, WebP, GIF · 각각 5 MB 이하" size="sm" variant="ghost" isIconOnly
              isDisabled={loading || attachments.length >= MAX_MESSAGE_IMAGES} icon={<Paperclip className="h-3.5 w-3.5" aria-hidden />}
              onClick={() => fileInput.current?.click()} />
            <AstryxButton label="선택한 텍스트 붙여넣기" tooltip="선택한 텍스트 붙여넣기" size="sm" variant="ghost" isIconOnly isDisabled={loading}
              icon={<Clipboard className="h-3.5 w-3.5" aria-hidden />} onClick={handlePasteSelection} />
            {project && <Text type="supporting" maxLines={1}>{project.name}</Text>}
            {project && (sourceStatus?.digestCount ?? 0) > 0 && (
              <ToggleButton size="sm" label={`Sources ${projectSourcesEnabled ? "on" : "off"}`} isPressed={projectSourcesEnabled} isDisabled={loading}
                tooltip="summary digest 자동 검색을 켜거나 끕니다. 원문 PDF는 필요한 질문에서만 확인합니다."
                icon={<BookOpen className="h-3 w-3" aria-hidden />} onPressedChange={() => setProjectSourcesEnabled(!projectSourcesEnabled)}>
                Sources {projectSourcesEnabled ? "on" : "off"}
              </ToggleButton>
            )}
          </div>
          {loading ? (
            <AstryxButton label="응답 중지" tooltip="응답 중지" variant="destructive" size="sm" isIconOnly
              icon={<StopCircle className="h-4 w-4" aria-hidden />}
              onClick={() => { aui.composer().cancel(); rpc.abortAgentStream().catch(console.error); }} />
          ) : (
            <AstryxButton label="전송" tooltip="전송" variant="primary" size="sm" isIconOnly isDisabled={isEmpty || attachmentsBlocked}
              icon={<Send className="h-4 w-4" aria-hidden />} onClick={() => aui.composer().send()} />
          )}
        </div>
      </ComposerPrimitive.Root>
    </div>
  );
}

export function AISidebar({
  responsePreferences: { searchEnabled, thinkingLevel },
  onSearchEnabledChange: setSearchEnabled,
  onThinkingLevelChange: setThinkingLevel,
  project,
  ollamaStatus: _ollamaStatus,
  activeDocumentName,
  getActiveDocumentContext,
  appSettings,
  editor,
  onClose,
  width,
  deepenRequest = null,
  onDeepenRequestConsumed,
  onDeepenResult,
  findCitationRequest = null,
  onFindCitationRequestConsumed,
  citationCheckRequest = null,
  onCitationCheckRequestConsumed,
  onApplyCitationRevision,
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
  const [preparedCitationCheckRequestId, setPreparedCitationCheckRequestId] = useState<string | null>(null);
  const [retryCitationRequest, setRetryCitationRequest] = useState<FindCitationRequest | null>(null);
  const [deepenApplyNotice, setDeepenApplyNotice] = useState<SelectionReviewNotice | null>(null);
  const modelKeyRef = useRef<string | null>(null);
  const deepenRequestRef = useRef<DeepenAnalysisRequest | null>(null);
  const findCitationRequestRef = useRef<FindCitationRequest | null>(null);
  const citationCheckRequestRef = useRef<CitationCheckRequest | null>(null);

  const activeProvider = appSettings?.sidebarAgentProvider ?? settings?.sidebarAgentProvider ?? "ollama";
  const activeModel = appSettings?.sidebarAgentProvider
    ? appSettings.sidebarAgentModel
    : settings?.sidebarAgentModel ?? settings?.modelProviders?.[activeProvider]?.model ?? "";
  const modelKey = `${activeProvider}:${activeModel}`;
  const searchAvailable = appSettings?.webSearchEnabled ?? settings?.webSearchEnabled ?? false;

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
    setDeepenApplyNotice(null);
  }, []);

  const loadThread = useCallback(
    async (threadId: string) => {
      if (!project?.path) return;
      const data = await rpc.getAgentThread(project.path, threadId);
      setDeepenApplyNotice(null);
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
      citationCheckRequestRef.current = null;
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
      citationCheckRequestRef.current = null;
      findCitationRequestRef.current = request;
      startNewThread();
      setPreparedFindCitationRequestId(request.id);
    },
    [startNewThread],
  );

  const consumeFindCitationRequest = useCallback(
    (requestId: string) => {
      setPreparedFindCitationRequestId((current) => current === requestId ? null : current);
      setRetryCitationRequest((current) => current?.id === requestId ? null : current);
      onFindCitationRequestConsumed?.(requestId);
    },
    [onFindCitationRequestConsumed],
  );

  const prepareCitationCheckRequest = useCallback(
    (request: CitationCheckRequest) => {
      deepenRequestRef.current = null;
      findCitationRequestRef.current = null;
      citationCheckRequestRef.current = request;
      setDeepenApplyNotice(null);
      startNewThread();
      setPreparedCitationCheckRequestId(request.id);
    },
    [startNewThread],
  );

  const consumeCitationCheckRequest = useCallback(
    (requestId: string) => {
      setPreparedCitationCheckRequestId((current) => current === requestId ? null : current);
      onCitationCheckRequestConsumed?.(requestId);
    },
    [onCitationCheckRequestConsumed],
  );

  const assistantAdapter = useMemo(
    () =>
      createScholarAgentAdapter(async (_messages, message) => {
        const activeDocument = getActiveDocumentContext?.();
        const lastMessage = _messages.at(-1);
        const images = lastMessage ? imagesFromMessage(lastMessage) : [];
        const deepen = deepenRequestRef.current;
        const isDeepen =
          deepen !== null &&
          message === buildDeepenAnalysisMessage(deepen);
        if (isDeepen) deepenRequestRef.current = null;
        const isValidate = isDeepen && deepen?.mode === "validate";
        const reviewLabel = isValidate ? "Validate" : "Deepen";
        const findCitation = findCitationRequestRef.current;
        const isFindCitation =
          findCitation !== null &&
          message === buildFindCitationMessage(findCitation);
        if (isFindCitation) findCitationRequestRef.current = null;
        const citationCheck = citationCheckRequestRef.current;
        const isCitationCheck =
          citationCheck !== null &&
          message === buildCitationCheckMessage(citationCheck);
        if (isCitationCheck) citationCheckRequestRef.current = null;
        const isPreparedRequest = isDeepen || isFindCitation || isCitationCheck;
        const wantsDetection = !isPreparedRequest && asksForAIScore(message);
        const selection = wantsDetection ? editor?.getSelectedText().trim() : "";
        const detectionInput = wantsDetection && editor ? {
          text: selection || detectionTextFromBlocks(editor.document),
          scope: selection ? "selection" as const : "document" as const,
        } : undefined;
        if (!isDeepen) setDeepenApplyNotice(null);
        // Snapshot the user's persistent choices before any awaits. Mandatory
        // search for a review affects this request, never the saved preference.
        const requestOptions = {
          searchEnabled: isValidate || isFindCitation || (!isCitationCheck && searchEnabled && searchAvailable),
          thinkingLevel,
        };
        const analysisMode = isDeepen
          ? deepen?.mode ?? "deepen"
          : isFindCitation
            ? "find-citation" as const
            : isCitationCheck
              ? "check-citations" as const
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
              ? `${reviewLabel}: ${deepen.selectedText.replace(/\s+/g, " ").trim().slice(0, 72)}`
              : isFindCitation && findCitation
                ? `Find Citation: ${findCitation.selectedText.replace(/\s+/g, " ").trim().slice(0, 64)}`
                : isCitationCheck && citationCheck
                  ? `Check Citations: ${citationCheck.selectedText.replace(/\s+/g, " ").trim().slice(0, 60)}`
                  : message;
            runThread = await rpc.createAgentThread(projectPath, activeProvider, activeModel, threadTitle, {
              projectSourcesEnabled,
            });
            setActiveThread(runThread);
          }
          await rpc.saveAgentThreadMessage(projectPath, runThread.id, "user", message, "complete", {
            ...requestOptions,
            images,
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
          ...requestOptions,
          activeDocument: isPreparedRequest ? undefined : activeDocument,
          detectionInput,
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
                punctuation: deepen.protection.punctuation,
                beforeSelection: deepen.documentContext.beforeSelection,
                afterSelection: deepen.documentContext.afterSelection,
              }
            : undefined,
          citationCheckContext: isCitationCheck && citationCheck
            ? {
                requestId: citationCheck.id,
                selectedText: citationCheck.selectedText,
                protection: citationCheck.protection,
                beforeSelection: citationCheck.documentContext.beforeSelection.slice(-4_000),
                afterSelection: citationCheck.documentContext.afterSelection.slice(0, 4_000),
              }
            : undefined,
          citationContext: isFindCitation && findCitation
            ? {
                selectedText: findCitation.selectedText,
                beforeSelection: findCitation.beforeSelection,
                afterSelection: findCitation.afterSelection,
                claims: findCitation.claims,
              }
            : undefined,
          ignoreHistory: isPreparedRequest || !canReuseThread,
          transformVisibleContent: isDeepen && deepen
            ? (content: string) => formatDeepenAnalysisForDisplay(content, deepen.protection)
            : undefined,
          onComplete: async (assistantMessage, status) => {
            const visibleAssistantMessage = isDeepen && deepen
              ? formatDeepenAnalysisForDisplay(assistantMessage, deepen.protection)
              : assistantMessage;

            const reviewNotice = isDeepen && deepen
              ? applySelectionReviewResult(deepen, assistantMessage, status, onDeepenResult)
              : null;
            if (reviewNotice) setDeepenApplyNotice(reviewNotice);

            if (!projectPath || !runThread || !visibleAssistantMessage.trim()) return;
            await rpc.saveAgentThreadMessage(projectPath, runThread.id, "assistant", visibleAssistantMessage, status, {
              ...requestOptions,
              provider: activeProvider,
              model: activeModel,
              analysisMode,
              ...(reviewNotice ? { selectionReview: reviewNotice } : {}),
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
      getActiveDocumentContext,
      editor,
      activeProvider,
      activeModel,
      activeThread,
      project?.path,
      selectedSkillIds,
      selectedFilePaths,
      lang,
      projectSourcesEnabled,
      searchEnabled,
      searchAvailable,
      thinkingLevel,
      slashCommands,
      refreshThreads,
      onDeepenResult,
    ],
  );
  const assistantRuntime = useLocalRuntime(assistantAdapter, { adapters: { attachments: imageAttachmentAdapter } });

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
      <AIDetectorSetup compact />
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
        request={citationCheckRequest}
        preparedRequestId={preparedCitationCheckRequestId}
        ready
        buildMessage={buildCitationCheckMessage}
        onPrepare={prepareCitationCheckRequest}
        onConsumed={consumeCitationCheckRequest}
      />
      <PreparedRequestDispatcher
        request={findCitationRequest ?? retryCitationRequest}
        preparedRequestId={preparedFindCitationRequestId}
        ready
        buildMessage={buildFindCitationMessage}
        onPrepare={prepareFindCitationRequest}
        onConsumed={consumeFindCitationRequest}
      />
      <div
        className="relative flex h-full flex-shrink-0 flex-col bg-sidebar"
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

        {project && <ProjectMemoryPanel key={project.path} projectPath={project.path} sourceName={activeDocumentName} getSelection={() => editor?.getSelectedText() ?? ""} />}

        {!activeThreadUsesCurrentModel && (
          <Banner status="warning" container="section" title="현재 선택된 model이 이 thread와 달라 다음 질문은 새 thread로 저장됩니다." />
        )}

        {deepenApplyNotice && (
          <div role={deepenApplyNotice.kind === "error" ? "alert" : "status"}>
            <Banner status={deepenApplyNotice.kind === "error" ? "warning" : "success"} container="section" title={deepenApplyNotice.message} />
          </div>
        )}

        {activeDocumentName && <div className="border-b border-sidebar-border px-3 py-1.5" title="전송할 때 현재 편집 내용과 저장 전 수정 사항을 자동으로 참조합니다. 긴 문서는 일부가 생략됩니다.">
          <Text type="supporting" maxLines={1}>문서 자동 참조: <span className="text-foreground">{activeDocumentName}</span></Text>
        </div>}

        <AssistantThread
          slashCommands={slashCommands}
          onOpenProjectSource={onOpenProjectSource}
          projectPath={project?.path ?? null}
          onRetryCitation={(claims, selectedText) => setRetryCitationRequest(createFindCitationRequest(selectedText, undefined, claims))}
          onApplyCitationRevision={onApplyCitationRevision}
        />

        {/^(Validate|Deepen):/.test(activeThread?.title ?? "") && (
          <p className="px-3 pt-2 text-xs leading-5 text-muted-foreground">
            후속 채팅의 개선문은 자동 적용되지 않습니다. 자동 교체하려면 원문을 선택하고 Validate 또는 Deepen을 실행하세요.
          </p>
        )}

        <AssistantComposer
          searchEnabled={searchEnabled}
          setSearchEnabled={setSearchEnabled}
          searchAvailable={searchAvailable}
          thinkingLevel={thinkingLevel}
          setThinkingLevel={setThinkingLevel}
          provider={activeProvider}
          model={activeModel}
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
