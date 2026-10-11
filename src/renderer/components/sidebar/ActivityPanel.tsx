import { rpc } from "../../rpc";
import React, { useEffect, useMemo, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { CommentsExtension } from "@blocknote/core/comments";
import { BellOff, Bot, Check, CircleDot, Download, MessageSquare, User, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { COLLAB_THREADS_MAP } from "../../../shared/collab/protocol";
import {
  readThreads,
  updateThreadMeta,
  type ThreadSnapshot,
  type ThreadStatus,
} from "../../../shared/collab/threads";
import { getEditorCollab } from "../../collab/editor-collab";
import {
  REVIEW_MAP,
  isDisabledReviewType,
  normalizeReviewCategory,
  reviewCategoryLabel,
  reviewSettingsOf,
  type ReviewCategory,
} from "../../../shared/collab/review";
import { SCHOLARPEN_AI, isAIUser, personaByUser } from "../../../shared/collab/personas";
import { AIActivitySection } from "./AIActivitySection";
import { decideChangeSet, usePendingChangeSets } from "../../collab/use-change-sets";
import { ZonesSection } from "./ZonesSection";
import { WatermarkResultCard } from "./WatermarkResultCard";
import { exportUnresolvedComments, unresolvedCommentsFilename } from "../../../shared/collab/comment-export";
import { aiTaskRunning, openClaimThreads, requestBulkComments, resolveAllComments } from "../../../shared/collab/bulk-comments";
import { EditLevelControl, useEditLevel } from "./EditLevelControl";
import { DecisionQueue } from "./DecisionQueue";
import { RevisionHistory } from "./RevisionHistory";

// Resolved comments are deleted shortly after resolution (see resolved-purge.ts), so there is no Resolved tab.
type Filter = "open" | "ai" | "mine";

const STATUS_LABEL: Record<ThreadStatus, string> = {
  open: "Open",
  "in-progress": "AI working",
  proposed: "Proposed",
  resolved: "Resolved",
};

function threadStatus(thread: ThreadSnapshot): ThreadStatus {
  if (thread.resolved) return "resolved";
  return thread.meta.status ?? "open";
}

function useThreads(editor: BlockNoteEditor<any, any, any> | null) {
  const [threads, setThreads] = useState<ThreadSnapshot[]>([]);
  useEffect(() => {
    const collab = editor ? getEditorCollab(editor) : null;
    if (!collab) {
      setThreads([]);
      return;
    }
    const map = collab.ydoc.getMap(COLLAB_THREADS_MAP);
    const refresh = () => setThreads(readThreads(map));
    refresh();
    map.observeDeep(refresh);
    return () => map.unobserveDeep(refresh);
  }, [editor]);
  return threads;
}

function useThreadPositions(editor: BlockNoteEditor<any, any, any> | null) {
  const [positions, setPositions] = useState<Map<string, { from: number; to: number }>>(new Map());
  useEffect(() => {
    const comments = editor?.getExtension(CommentsExtension);
    if (!comments) return;
    setPositions(comments.store.state.threadPositions);
    return comments.store.subscribe(() => setPositions(comments.store.state.threadPositions));
  }, [editor]);
  return positions;
}

/** Review types the project turned off; their open comments are hidden unless asked for. */
function useDisabledReviewTypes(editor: BlockNoteEditor<any, any, any> | null) {
  const [disabled, setDisabled] = useState<ReviewCategory[]>([]);
  useEffect(() => {
    const collab = editor ? getEditorCollab(editor) : null;
    if (!collab) {
      setDisabled([]);
      return;
    }
    const map = collab.ydoc.getMap(REVIEW_MAP);
    const refresh = () => setDisabled(reviewSettingsOf(map).muted);
    refresh();
    map.observe(refresh);
    return () => map.unobserve(refresh);
  }, [editor]);
  return disabled;
}

interface ActivityPanelProps {
  editor: BlockNoteEditor<any, any, any> | null;
  documentName: string | null;
  projectPath?: string;
  onExported?: () => Promise<void>;
}

export function ActivityPanel({ editor, documentName, projectPath, onExported }: ActivityPanelProps) {
  const threads = useThreads(editor);
  const positions = useThreadPositions(editor);
  const disabledTypes = useDisabledReviewTypes(editor);
  const [showDisabledTypes, setShowDisabledTypes] = useState(false);
  const changeSets = usePendingChangeSets(editor);
  const pendingChangeSets = new Set(changeSets.map((set) => String(set.id)));
  const [filter, setFilter] = useState<Filter>("open");
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [bulkInstructions, setBulkInstructions] = useState("");
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<{ message: string; error: boolean } | null>(null);
  const collab = editor ? getEditorCollab(editor) : null;
  const [editLevel] = useEditLevel(collab?.ydoc ?? null);
  useEffect(() => { setExportResult(null); }, [editor, projectPath]);
  useEffect(() => { setBulkInstructions(""); setBulkError(null); }, [editor, projectPath]);
  // Lists, counts and bulk actions all work on the comments the panel shows.
  const inScope = (thread: ThreadSnapshot) => threadStatus(thread) !== "resolved" &&
    (showDisabledTypes || !isDisabledReviewType(thread.meta.category, disabledTypes));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- inScope reads exactly these values.
  const scoped = useMemo(() => threads.filter(inScope), [threads, disabledTypes, showDisabledTypes]);
  const hiddenByType = showDisabledTypes ? 0 : threads.filter(thread => threadStatus(thread) !== "resolved" &&
    isDisabledReviewType(thread.meta.category, disabledTypes)).length;
  const bulkTargets = openClaimThreads(scoped);
  const bulkBusy = aiTaskRunning(threads);

  const askAll = () => {
    if (!collab) return;
    setBulkError(null);
    try {
      if (pendingChangeSets.size) throw new Error("Accept or reject the pending edits first, so AI can work from one settled manuscript.");
      requestBulkComments(collab.ydoc, bulkInstructions, inScope);
      setBulkInstructions("");
    } catch (error) { setBulkError(error instanceof Error ? error.message : String(error)); }
  };

  const exportComments = async () => {
    if (!editor || !collab || !projectPath || !documentName || exporting) return;
    if (collab.docKey !== `${projectPath}::${documentName}`) return;
    setExporting(true);
    setExportResult(null);
    try {
      // Read live state at click time, including unsaved comments and edits.
      const doc = editor.prosemirrorState.doc;
      const livePositions = editor.getExtension(CommentsExtension)?.store.state.threadPositions;
      const report = exportUnresolvedComments({ documentName,
        entries: readThreads(collab.ydoc.getMap(COLLAB_THREADS_MAP)).filter(inScope).map(thread => {
          const range = livePositions?.get(thread.id);
          const from = Math.max(0, range?.from ?? 0);
          const to = Math.min(doc.content.size, range?.to ?? 0);
          return { thread, position: range?.from, reference: range && from < to
            ? doc.textBetween(from, to, "\n\n", node => {
              if (node.type.name === "citation") return `[@${node.attrs.citekey}${node.attrs.locator ? `, ${node.attrs.locator}` : ""}]`;
              if (node.type.name === "inlineMath") return `$${node.attrs.formula ?? ""}$`;
              return node.type.spec.leafText?.(node) ?? "";
            }) : null };
        }),
      });
      if (!report.count) { setExportResult({ message: "내보낼 미해결 코멘트가 없습니다.", error: false }); return; }
      const path = await rpc.exportFile(projectPath, unresolvedCommentsFilename(documentName), report.markdown);
      setExportResult({ message: `${report.count}개 코멘트 저장됨: ${path}`, error: false });
      await onExported?.();
    } catch (error) {
      setExportResult({ message: error instanceof Error ? error.message : String(error), error: true });
    } finally { setExporting(false); }
  };

  const visible = useMemo(() => {
    const filtered = scoped.filter((thread) => {
      if (filter === "ai") return thread.meta.assignee === "ai" || isAIUser(thread.comments[0]?.userId);
      if (filter === "mine") return thread.meta.assignee === "me";
      return true;
    });
    return filtered.sort((a, b) =>
      (positions.get(a.id)?.from ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id)?.from ?? Number.MAX_SAFE_INTEGER));
  }, [scoped, filter, positions]);

  const counts = useMemo(() => ({
    open: scoped.length,
    ai: scoped.filter((t) => t.meta.assignee === "ai" || isAIUser(t.comments[0]?.userId)).length,
    mine: scoped.filter((t) => t.meta.assignee === "me").length,
  }), [scoped]);

  const setMeta = (threadId: string, patch: Parameters<typeof updateThreadMeta>[2]) => {
    if (!collab) return;
    collab.ydoc.transact(() => updateThreadMeta(collab.ydoc.getMap(COLLAB_THREADS_MAP), threadId, patch));
  };

  const referenceText = (threadId: string) => {
    const position = positions.get(threadId);
    const doc = editor?.prosemirrorView?.state.doc;
    if (!position || !doc) return null;
    const to = Math.min(position.to, doc.content.size);
    return doc.textBetween(Math.max(0, position.from), to, " ", " ").trim().slice(0, 140);
  };

  if (!editor || !collab) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Open a document to see its comments and AI activity.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AIActivitySection editor={editor} />
      <WatermarkResultCard threads={threads} onDismiss={threadId => setMeta(threadId, { resultDismissedAt: Date.now() })} />
      {categoryError && <p role="alert" className="px-3 py-1 text-xs text-red-600">{categoryError}</p>}
      <ZonesSection editor={editor} />
      <RevisionHistory ydoc={collab.ydoc} documentName={documentName} projectPath={projectPath} onExported={onExported} />
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="mr-auto truncate text-xs font-medium text-foreground">
          Comments{documentName ? ` · ${documentName.replace(".scholarpen.json", "")}` : ""}
        </span>
        {(["open", "ai", "mine"] as Filter[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={cn(
              "rounded px-1.5 py-0.5 text-[11px] capitalize",
              filter === value ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {value === "ai" ? "AI" : value} {counts[value] > 0 ? counts[value] : ""}
          </button>
        ))}
      </div>
      <div className="border-b border-border px-3 py-2">
        <button type="button" onClick={() => void exportComments()}
          disabled={exporting || counts.open === 0 || !projectPath || collab.docKey !== `${projectPath}::${documentName}`}
          title="현재 문서의 미해결 코멘트 전체를 본문·답글과 함께 exports 폴더에 저장합니다."
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">
          <Download className="h-3.5 w-3.5" />
          {exporting ? "Exporting…" : `Export unresolved (.md) · ${counts.open}`}
        </button>
        <div className="mt-2 flex items-center gap-2" role="group" aria-label="All open comments">
          <button type="button" onClick={askAll} disabled={!bulkTargets.length || bulkBusy}
            title="Address AI and your comments together in one consistent manuscript revision. AI reads the project's other documents and cites from references.bib, adding verified new works to it first."
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40">
            <Bot className="h-3 w-3" /> Ask AI
          </button>
          <button type="button" onClick={() => { resolveAllComments(collab.ydoc, inScope); setBulkError(null); }} disabled={!counts.open}
            title="Dismiss all open comments without changing the manuscript or accepting suggested edits"
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40">
            <Check className="h-3 w-3" /> Resolve all
          </button>
          <span className="text-[11px] text-muted-foreground">All comments · AI + yours</span>
        </div>
        <EditLevelControl ydoc={collab.ydoc} />
        {!!bulkTargets.length && <input value={bulkInstructions} onInput={event => setBulkInstructions(event.currentTarget.value)}
          aria-label="Instructions for all comments" placeholder="Optional direction for the whole revision…"
          className="mt-2 w-full rounded border border-border bg-background px-2 py-1 text-xs" />}
        {bulkError && <p role="alert" className="mt-1 text-[11px] text-red-600">{bulkError}</p>}
        {(hiddenByType > 0 || showDisabledTypes) && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {showDisabledTypes
              ? "Showing comments of types turned off in this project. "
              : `${hiddenByType} open ${hiddenByType === 1 ? "comment" : "comments"} of types turned off in this project hidden. `}
            <button type="button" onClick={() => setShowDisabledTypes(value => !value)} className="underline hover:text-foreground">
              {showDisabledTypes ? "Hide" : "Show"}
            </button>
          </p>
        )}
        {exportResult && <p role={exportResult.error ? "alert" : "status"}
          className={cn("mt-1 break-all text-[11px]", exportResult.error ? "text-red-600" : "text-muted-foreground")}>
          {exportResult.message}
        </p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DecisionQueue ydoc={collab.ydoc} threads={threads} level={editLevel} reference={referenceText}
          onSelect={threadId => editor.getExtension(CommentsExtension)?.selectThread(threadId)}
          blocked={pendingChangeSets.size ? "Accept or reject the pending edits first, so AI can work from one settled manuscript." : null} />
        {visible.length === 0 && (
          <p className="p-4 text-xs leading-5 text-muted-foreground">
            {filter === "open"
              ? "No open threads. Select text and use the comment button, or type / and choose Add Comment. ScholarPen AI starts on each comment you save."
              : "Nothing here."}
          </p>
        )}
        {visible.map((thread) => (
          <ThreadRow
            key={thread.id}
            thread={thread}
            reference={thread.meta.scope === "document" ? "Whole manuscript" : referenceText(thread.id)}
            detached={thread.meta.scope !== "document" && !positions.has(thread.id)}
            onSelect={() => editor.getExtension(CommentsExtension)?.selectThread(thread.id)}
            onAssign={(assignee) => setMeta(thread.id, {
              assignee, status: "open", statusNote: undefined,
              ...(assignee === "ai" ? { requestedAt: Date.now(), manual: undefined } : { manual: true }),
            })}
            onResolve={() => setMeta(thread.id, { status: "resolved" })}
            coordinated={changeSets.some(set => String(set.id) === String(thread.meta.changeSet) && !!set.info?.addressedThreadIds)}
            onDecideChange={thread.meta.changeSet !== undefined && pendingChangeSets.has(String(thread.meta.changeSet))
              ? (accept) => decideChangeSet(editor, thread.meta.changeSet!, accept)
              : undefined}
            onMute={normalizeReviewCategory(thread.meta.category) ? () => {
              const category = normalizeReviewCategory(thread.meta.category)!;
              setCategoryError(null);
              void rpc.collabSetReviewCategory(collab.docKey, category, false)
                .catch(error => setCategoryError(error instanceof Error ? error.message : String(error)));
            } : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function ThreadRow({ thread, reference, detached, onSelect, onAssign, onResolve, onMute, onDecideChange, coordinated }: {
  thread: ThreadSnapshot;
  reference: string | null;
  /** The commented text is no longer in the document, so there is nothing to highlight. */
  detached?: boolean;
  onSelect: () => void;
  onAssign: (assignee: "ai" | "me") => void;
  onResolve: () => void;
  /** Disables this category project-wide; its open comments are hidden, not resolved. */
  onMute?: () => void;
  /** Accepts or rejects the AI's change set for this thread, when one is pending. */
  onDecideChange?: (accept: boolean) => void;
  coordinated?: boolean;
}) {
  const status = threadStatus(thread);
  const first = thread.comments.find((comment) => !comment.deleted);
  const author = personaByUser(first?.userId);
  const fromAI = author !== null;
  const replies = thread.comments.filter((comment) => !comment.deleted).length - 1;
  const last = [...thread.comments].reverse().find((comment) => !comment.deleted);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => { if (event.key === "Enter") onSelect(); }}
      className="group cursor-pointer border-b border-border px-3 py-2.5 hover:bg-muted/50"
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px]">
        {author ? <Bot className="h-3 w-3" style={{ color: author.color }} /> : <User className="h-3 w-3 text-blue-600" />}
        <span className="font-medium text-foreground">{author ? author.name : "You"}</span>
        {thread.meta.severity && (
          <span className={cn("rounded px-1 text-[10px]",
            thread.meta.severity === "high" ? "bg-red-500/10 text-red-600"
              : thread.meta.severity === "medium" ? "bg-amber-500/10 text-amber-700" : "bg-muted text-muted-foreground")}>
            {reviewCategoryLabel(thread.meta.category)}
          </span>
        )}
        <span className={cn("ml-auto flex items-center gap-1 rounded-full px-1.5 py-px text-[10px]",
          status === "in-progress" ? "bg-violet-500/10 text-violet-700"
            : status === "proposed" ? "bg-emerald-500/10 text-emerald-700"
              : status === "resolved" ? "bg-muted text-muted-foreground" : "bg-blue-500/10 text-blue-700")}>
          {status === "in-progress" && <CircleDot className="h-2.5 w-2.5 animate-pulse" />}
          {STATUS_LABEL[status]}
          {thread.meta.assignee && status !== "resolved" &&
            ` · ${thread.meta.assignee === "ai" ? SCHOLARPEN_AI.shortName : "you"}`}
        </span>
      </div>
      {reference ? (
        <p className="mb-1 truncate border-l-2 border-amber-400/70 pl-2 text-[11px] text-muted-foreground">{reference}</p>
      ) : detached && (
        <p className="mb-1 border-l-2 border-border pl-2 text-[11px] italic text-muted-foreground">
          The commented text is no longer in the document.
        </p>
      )}
      <p className="line-clamp-3 text-xs leading-5 text-foreground">{first?.text || "(empty comment)"}</p>
      {replies > 0 && last && last !== first && (
        <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
          <span className="font-medium">{personaByUser(last.userId)?.shortName ?? "You"}:</span> {last.text}
        </p>
      )}
      {thread.meta.statusNote && status !== "resolved" && (
        <p className="mt-1 text-[11px] italic leading-4 text-muted-foreground">{thread.meta.statusNote}</p>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1 opacity-70 group-hover:opacity-100" onClick={(event) => event.stopPropagation()}>
        {onDecideChange && (
          <>
            <button type="button" onClick={() => onDecideChange(true)}
              className="flex items-center gap-1 rounded border border-emerald-600/30 px-1.5 py-0.5 text-[11px] text-emerald-700 hover:bg-emerald-500/10">
              <Check className="h-3 w-3" /> {coordinated ? "Accept coordinated revision" : "Accept change"}
            </button>
            <button type="button" onClick={() => onDecideChange(false)}
              className="flex items-center gap-1 rounded border border-red-600/30 px-1.5 py-0.5 text-[11px] text-red-600 hover:bg-red-500/10">
              <X className="h-3 w-3" /> {coordinated ? "Reject coordinated revision" : "Reject change"}
            </button>
          </>
        )}
        {thread.meta.assignee !== "ai" && !thread.meta.bulkRequestId && (
          <SmallButton icon={<Bot className="h-3 w-3" />} label={`Ask ${SCHOLARPEN_AI.shortName}`}
            onClick={() => onAssign("ai")} />
        )}
        {thread.meta.assignee !== "me" && (
          <SmallButton icon={<User className="h-3 w-3" />} label="I'll handle" onClick={() => onAssign("me")} />
        )}
        <SmallButton icon={<Check className="h-3 w-3" />} label="Resolve" onClick={onResolve} />
        {onMute && fromAI && (
          <SmallButton icon={<BellOff className="h-3 w-3" />} label="Disable type in project" onClick={onMute} />
        )}
      </div>
    </div>
  );
}

function SmallButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {icon}
      {label}
    </button>
  );
}

export type RightPanelTab = "activity" | "assistant" | "project";

const TAB_LABEL: Record<RightPanelTab, string> = { activity: "Activity", project: "Project", assistant: "Assistant" };

export function ActivityPanelHeader({ tab, onTab, onClose }: {
  tab: RightPanelTab;
  onTab: (tab: RightPanelTab) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
      {(["activity", "project", "assistant"] as const).map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => onTab(value)}
          className={cn("rounded px-2 py-1 text-xs font-medium",
            tab === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
        >
          {TAB_LABEL[value]}
        </button>
      ))}
      <button type="button" onClick={onClose} aria-label="Close panel"
        className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
