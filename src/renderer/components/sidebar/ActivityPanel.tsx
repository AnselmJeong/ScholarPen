import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Button } from "@astryxdesign/core/Button";
import { Badge } from "@astryxdesign/core/Badge";
import { Link } from "@astryxdesign/core/Link";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { PanelActions, PanelEmpty, PanelError, PanelHeader, PanelNote, PanelQuote } from "./panel-kit";
import { AIDetectorSetup } from "../../../plugins/ai-writing-score/ui/AIDetectorSetup";
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
import { AIDetectionResult } from "../../../plugins/ai-writing-score/ui/AIDetectionResult";
import { asksForAIScore, isAIDetectionResult } from "../../../shared/ai-detection";
import { WatermarkResultCard } from "../../../plugins/text-cleanup/ui/WatermarkResultCard";
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
    return <PanelEmpty>Open a document to see its comments and AI activity.</PanelEmpty>;
  }

  const exportDisabled = exporting || counts.open === 0 || !projectPath || collab.docKey !== `${projectPath}::${documentName}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AIDetectorSetup compact />
      <AIActivitySection editor={editor} />
      <WatermarkResultCard threads={threads} onDismiss={threadId => setMeta(threadId, { resultDismissedAt: Date.now() })} />
      {categoryError && <div className="px-3 py-1"><PanelError>{categoryError}</PanelError></div>}
      <ZonesSection editor={editor} />
      <RevisionHistory ydoc={collab.ydoc} documentName={documentName} projectPath={projectPath} onExported={onExported} />
      <PanelHeader icon={MessageSquare} title="Comments" meta={documentName ? documentName.replace(".scholarpen.json", "") : undefined}>
        <SegmentedControl label="Comment filter" size="sm" layout="fill" value={filter} onChange={(value) => setFilter(value as Filter)}>
          {(["open", "ai", "mine"] as Filter[]).map((value) => (
            <SegmentedControlItem key={value} value={value}
              label={`${value === "ai" ? "AI" : value === "open" ? "Open" : "Mine"}${counts[value] > 0 ? ` ${counts[value]}` : ""}`} />
          ))}
        </SegmentedControl>
        {/* Saves every unresolved comment of this document, with replies, to exports/. */}
        <Button label={exporting ? "Exporting…" : `Export unresolved (.md) · ${counts.open}`} size="sm" variant="ghost"
          isDisabled={exportDisabled} isLoading={exporting} icon={<Download className="h-3.5 w-3.5" aria-hidden />} onClick={() => void exportComments()} />
        <PanelActions label="All open comments">
          <Button label="Ask AI" size="sm" variant="primary" isDisabled={!bulkTargets.length || bulkBusy}
            tooltip="Address AI and your comments together in one consistent manuscript revision. AI reads the project's other documents and cites from references.bib, adding verified new works to it first."
            icon={<Bot className="h-3 w-3" aria-hidden />} onClick={askAll} />
          <Button label="Resolve all" size="sm" variant="secondary" isDisabled={!counts.open}
            tooltip="Dismiss all open comments without changing the manuscript or accepting suggested edits"
            icon={<Check className="h-3 w-3" aria-hidden />} onClick={() => { resolveAllComments(collab.ydoc, inScope); setBulkError(null); }} />
          <Text type="supporting">All comments · AI + yours</Text>
        </PanelActions>
        <EditLevelControl ydoc={collab.ydoc} />
        {!!bulkTargets.length && <TextInput label="Instructions for all comments" isLabelHidden size="sm" value={bulkInstructions}
          onChange={setBulkInstructions} onEnter={askAll} placeholder="Optional direction for the whole revision…" />}
        {bulkError && <PanelError>{bulkError}</PanelError>}
        {(hiddenByType > 0 || showDisabledTypes) && (
          <PanelNote>
            {showDisabledTypes
              ? "Showing comments of types turned off in this project. "
              : `${hiddenByType} open ${hiddenByType === 1 ? "comment" : "comments"} of types turned off in this project hidden. `}
            <Link onClick={() => setShowDisabledTypes(value => !value)}>{showDisabledTypes ? "Hide" : "Show"}</Link>
          </PanelNote>
        )}
        {exportResult && (exportResult.error
          ? <PanelError>{exportResult.message}</PanelError>
          : <PanelNote role="status" className="break-all">{exportResult.message}</PanelNote>)}
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DecisionQueue ydoc={collab.ydoc} threads={threads} level={editLevel} reference={referenceText}
          onSelect={threadId => editor.getExtension(CommentsExtension)?.selectThread(threadId)}
          blocked={pendingChangeSets.size ? "Accept or reject the pending edits first, so AI can work from one settled manuscript." : null} />
        {visible.length === 0 && (
          <div className="p-4">
            <PanelNote>
              {filter === "open"
                ? "No open threads. Select text and use the comment button, or type / and choose Add Comment. ScholarPen AI starts on each comment you save."
                : "Nothing here."}
            </PanelNote>
          </div>
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
  const detection = thread.meta.documentAction === "ai-score" || asksForAIScore(first?.text ?? "") || isAIDetectionResult(last?.text ?? "");

  const statusVariant = status === "in-progress" ? "purple" : status === "proposed" ? "success" : status === "resolved" ? "neutral" : "info";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => { if (event.key === "Enter") onSelect(); }}
      className="group cursor-pointer space-y-1 border-b border-sidebar-border px-3 py-2.5 hover:bg-sidebar-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <div className="flex items-center gap-1.5">
        {author ? <Bot className="h-3.5 w-3.5" style={{ color: author.color }} aria-hidden /> : <User className="h-3.5 w-3.5 text-primary" aria-hidden />}
        <Text type="label" weight="semibold">{author ? author.name : "You"}</Text>
        {thread.meta.severity && (
          <Badge label={reviewCategoryLabel(thread.meta.category)}
            variant={thread.meta.severity === "high" ? "error" : thread.meta.severity === "medium" ? "warning" : "neutral"} />
        )}
        <span className="ml-auto">
          <Badge variant={statusVariant}
            icon={status === "in-progress" ? <CircleDot className="h-2.5 w-2.5 animate-pulse" aria-hidden /> : undefined}
            label={`${STATUS_LABEL[status]}${thread.meta.assignee && status !== "resolved" ? ` · ${thread.meta.assignee === "ai" ? SCHOLARPEN_AI.shortName : "you"}` : ""}`} />
        </span>
      </div>
      {reference ? <PanelQuote>{reference}</PanelQuote> : detached && <PanelQuote muted>The commented text is no longer in the document.</PanelQuote>}
      <p className="line-clamp-3 text-xs leading-5 text-foreground">{first?.text || "(empty comment)"}</p>
      {replies > 0 && last && last !== first && (
        isAIUser(last.userId) && last.text.startsWith("**DetectorScope ·")
          ? <AIDetectionResult text={last.text} />
          : <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
              <span className="font-medium">{personaByUser(last.userId)?.shortName ?? "You"}:</span> {last.text}
            </p>
      )}
      {thread.meta.statusNote && status !== "resolved" && (
        <p className="text-xs italic leading-5 text-muted-foreground">{thread.meta.statusNote}</p>
      )}
      <div className="pt-0.5 opacity-80 group-hover:opacity-100" onClick={(event) => event.stopPropagation()}>
        <PanelActions>
          {onDecideChange && (
            <>
              <Button size="sm" variant="secondary" icon={<Check className="h-3 w-3" aria-hidden />}
                label={coordinated ? "Accept coordinated revision" : "Accept change"} onClick={() => onDecideChange(true)} />
              <Button size="sm" variant="ghost" icon={<X className="h-3 w-3" aria-hidden />}
                label={coordinated ? "Reject coordinated revision" : "Reject change"} onClick={() => onDecideChange(false)} />
            </>
          )}
          {thread.meta.assignee !== "ai" && !thread.meta.bulkRequestId && !detection && (
            <SmallButton icon={<Bot className="h-3 w-3" aria-hidden />} label={`Ask ${SCHOLARPEN_AI.shortName}`}
              onClick={() => onAssign("ai")} />
          )}
          {thread.meta.assignee !== "me" && (
            <SmallButton icon={<User className="h-3 w-3" aria-hidden />} label="I'll handle" onClick={() => onAssign("me")} />
          )}
          <SmallButton icon={<Check className="h-3 w-3" aria-hidden />} label="Resolve" onClick={onResolve} />
          {onMute && fromAI && (
            <SmallButton icon={<BellOff className="h-3 w-3" aria-hidden />} label="Disable type in project" onClick={onMute} />
          )}
        </PanelActions>
      </div>
    </div>
  );
}

function SmallButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return <Button size="sm" variant="ghost" icon={icon} label={label} onClick={onClick} />;
}

export type RightPanelTab = "activity" | "history" | "assistant" | "project" | "revision";

const TAB_LABEL: Record<RightPanelTab, string> = { revision: "심사 답변", activity: "Activity", history: "History", project: "Project", assistant: "Assistant" };

export function ActivityPanelHeader({ tab, onTab, onClose, revisionAvailable = false }: {
  revisionAvailable?: boolean;
  tab: RightPanelTab;
  onTab: (tab: RightPanelTab) => void;
  onClose: () => void;
}) {
  const tabs = [...(revisionAvailable ? ["revision" as const] : []), "activity", "history", "project", "assistant"] as const;
  return (
    <div className="workbench-panel-header flex h-9 flex-shrink-0 items-end gap-1 border-b border-sidebar-border pl-1 pr-1.5">
      <div className="min-w-0 flex-1">
        <TabList value={tab} onChange={(value) => onTab(value as RightPanelTab)} size="sm" role="tablist" aria-label="Side panel">
          {tabs.map((value) => <Tab key={value} value={value} label={TAB_LABEL[value]} />)}
        </TabList>
      </div>
      <div className="flex h-full items-center">
        <Button label="Close panel" variant="ghost" size="sm" isIconOnly icon={<X className="h-3.5 w-3.5" aria-hidden="true" />} onClick={onClose} />
      </div>
    </div>
  );
}
