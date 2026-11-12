import { ProjectReviewOptions } from "./ProjectReviewOptions";
import React, { useEffect, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { CommentsExtension } from "@blocknote/core/comments";
import { AlertTriangle, Bot, Check, ChevronDown, ChevronRight, CircleDot, Clock, Pause, Play, ScanSearch, Undo2, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { rpc } from "../../rpc";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { PanelActions, PanelError, PanelNote } from "./panel-kit";
import { useAgentActivity } from "../../collab/use-agent-activity";
import { getEditorCollab } from "../../collab/editor-collab";
import type { PendingChangeSet } from "../../collab/suggestions";
import { decideAllChangeSets, decideChangeSet, usePendingChangeSets } from "../../collab/use-change-sets";
import type { AgentActivityMessage, AgentJobView } from "../../../shared/collab/agent-types";
import { REVIEW_MAP, reviewSettingsOf, updateReviewSettings, type ReviewSettings, type ReviewProgress } from "../../../shared/collab/review";
import { SCHOLARPEN_AI } from "../../../shared/collab/personas";

function useReviewSettings(editor: BlockNoteEditor<any, any, any>) {
  const collab = getEditorCollab(editor);
  const [settings, setSettings] = useState<ReviewSettings | null>(null);
  const [progress, setProgress] = useState<ReviewProgress | null>(null);
  useEffect(() => {
    if (!collab) return;
    const map = collab.ydoc.getMap(REVIEW_MAP);
    const refresh = () => {
      setSettings(reviewSettingsOf(map));
      setProgress((map.get("progress") as ReviewProgress | undefined) ?? null);
    };
    refresh();
    map.observe(refresh);
    return () => map.unobserve(refresh);
  }, [collab]);
  const update = (patch: Partial<ReviewSettings>) => {
    if (!collab) return;
    collab.ydoc.transact(() => updateReviewSettings(collab.ydoc.getMap(REVIEW_MAP), patch));
  };
  return [settings, update, progress] as const;
}


const JOB_ICON: Record<AgentJobView["state"], React.ReactNode> = {
  queued: <Clock className="h-3 w-3 text-muted-foreground" />,
  waiting: <Clock className="h-3 w-3 text-amber-600" />,
  working: <CircleDot className="h-3 w-3 animate-pulse text-primary" />,
  done: <Check className="h-3 w-3 text-emerald-600" />,
  failed: <AlertTriangle className="h-3 w-3 text-destructive" />,
  cancelled: <X className="h-3 w-3 text-muted-foreground" />,
};

const JOB_STATE: Record<AgentJobView["state"], string> = {
  queued: "Queued",
  waiting: "Waiting for you",
  working: "Working",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};

/** AI work queue and pending change sets for the active document. */
export function AIActivitySection({ editor }: { editor: BlockNoteEditor<any, any, any> }) {
  const collab = getEditorCollab(editor);
  const activity = useAgentActivity(collab?.docKey ?? null);
  const changeSets = usePendingChangeSets(editor);
  const [showDone, setShowDone] = useState(false);
  const jobs = activity?.jobs ?? [];
  const active = jobs.filter((job) => ["queued", "waiting", "working"].includes(job.state));
  const finished = jobs.filter((job) => !active.includes(job));
  const paused = activity?.paused ?? false;
  const [review, updateReview, reviewProgress] = useReviewSettings(editor);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const reviewSection = () => {
    if (!collab) return;
    setReviewError(null);
    const blockId = editor.getTextCursorPosition().block.id;
    rpc.collabReviewSection(collab.docKey, blockId)
      .catch((error) => setReviewError(error instanceof Error ? error.message : String(error)));
  };

  const scrollTo = (from: number) => {
    const view = editor.prosemirrorView;
    if (!view) return;
    (view.domAtPos(from).node as Element | null)?.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <section aria-label="ScholarPen AI" className="border-b border-sidebar-border">
      <div className="space-y-2 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Bot className="h-3.5 w-3.5 text-primary" aria-hidden />
          <Text type="label" weight="semibold">ScholarPen AI</Text>
          <Text type="supporting">
            {paused ? "· paused" : active.length > 0 ? `· ${JOB_STATE[active[0].state].toLowerCase()}` : "· idle"}
          </Text>
          <div className="ml-auto flex">
            <IconButton
              label="Review the section at the cursor, including resolved paragraphs"
              disabled={!collab}
              onClick={reviewSection}
              icon={<ScanSearch className="h-3.5 w-3.5" aria-hidden />}
            />
            <IconButton
              label={paused ? "Resume AI" : "Pause AI"}
              onClick={() => void rpc.collabSetAgentPaused(!paused)}
              icon={paused ? <Play className="h-3.5 w-3.5" aria-hidden /> : <Pause className="h-3.5 w-3.5" aria-hidden />}
            />
            <IconButton
              label="Undo last AI edit"
              disabled={!activity?.canUndo || !collab}
              onClick={() => collab && void rpc.collabUndoAI(collab.docKey)}
              icon={<Undo2 className="h-3.5 w-3.5" aria-hidden />}
            />
          </div>
        </div>

        {review && (
          <div className="flex items-center gap-2">
            <CheckboxInput label="Review whole document" size="sm" value={review.autoReview}
              onChange={(checked) => updateReview({ autoReview: checked })} />
            <div className="ml-auto w-40">
              <Selector label="Minimum severity" isLabelHidden size="sm" value={review.minSeverity}
                options={[
                  { value: "low", label: "All findings" },
                  { value: "medium", label: "Medium and up" },
                  { value: "high", label: "Serious issues only" },
                ]}
                onChange={(value) => { if (value) updateReview({ minSeverity: value as ReviewSettings["minSeverity"] }); }} />
            </div>
          </div>
        )}
        {review && (
          <PanelNote>
            {review.minSeverity === "high" && "Only clear problems that materially affect the argument or evidence. Optional improvements are skipped. "}
            Resolved paragraphs stay excluded from automatic review. Use the review button to check them again.
          </PanelNote>
        )}
        {reviewProgress && reviewProgress.totalSections > 0 && (
          <PanelNote role="status">
            {reviewProgress.reviewedSections} / {reviewProgress.totalSections} sections reviewed
            {reviewProgress.reviewedSections === reviewProgress.totalSections ? " · Up to date" : ""}
          </PanelNote>
        )}
        {collab && <ProjectReviewOptions key={collab.docKey} collab={collab} />}
        {reviewError && <PanelError>{reviewError}</PanelError>}
      </div>
      {active.length > 0 && <div className="pb-1">{active.map((job) => <JobRow key={job.id} job={job} editor={editor} />)}</div>}
      {finished.length > 0 && (
        <div className="px-3 pb-1.5">
          <Button size="sm" variant="ghost" label={`${showDone ? "Hide" : "Show"} ${finished.length} finished`} onClick={() => setShowDone((value) => !value)} />
        </div>
      )}
      {showDone && <div className="pb-1">{finished.map((job) => <JobRow key={job.id} job={job} editor={editor} />)}</div>}

      {changeSets.length > 0 && (
        <div className="border-t border-sidebar-border">
          <div className="flex items-center gap-1 px-3 py-1.5">
            <Text type="label" weight="semibold">
              {changeSets.length} AI {changeSets.length === 1 ? "change" : "changes"} to review
            </Text>
            <div className="ml-auto">
              <PanelActions>
                <Button label="Accept all" size="sm" variant="secondary" onClick={() => decideAllChangeSets(editor, true)} />
                <Button label="Reject all" size="sm" variant="ghost" onClick={() => decideAllChangeSets(editor, false)} />
              </PanelActions>
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {changeSets.map((set) => <ChangeSetRow key={String(set.id)} set={set} editor={editor} scrollTo={scrollTo} />)}
          </div>
        </div>
      )}
    </section>
  );
}

function JobRow({ job, editor }: { job: AgentJobView; editor: BlockNoteEditor<any, any, any> }) {
  const open = () => {
    if (job.threadId) editor.getExtension(CommentsExtension)?.selectThread(job.threadId);
  };
  return (
    <button type="button" onClick={open}
      className="flex w-full items-start gap-1.5 px-3 py-1 text-left hover:bg-sidebar-accent/60">
      <span className="mt-1">{JOB_ICON[job.state]}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-foreground">
          {job.kind === "review" ? "Review: " : job.kind === "draft" ? "Draft: " : ""}{job.label}
        </span>
        <span className={cn("block text-[11px]", job.state === "failed" ? "text-destructive" : "text-muted-foreground")}>
          {JOB_STATE[job.state]}{job.detail ? ` · ${job.detail}` : ""}
        </span>
      </span>
    </button>
  );
}

function IconButton({ label, icon, onClick, disabled }: {
  label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean;
}) {
  return <Button label={label} tooltip={label} variant="ghost" size="sm" isIconOnly isDisabled={disabled} icon={icon} onClick={onClick} />;
}

/** One AI request's changes: decided as a unit, with an optional per-paragraph review. */
function ChangeSetRow({ set, editor, scrollTo }: {
  set: PendingChangeSet;
  editor: BlockNoteEditor<any, any, any>;
  scrollTo: (from: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = set.paragraphs.length;
  const coordinated = !!set.info?.addressedThreadIds;
  return (
    <div className="border-b border-sidebar-border/60 last:border-b-0">
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <button type="button" onClick={() => setOpen((value) => !value)} aria-label={open ? "Hide details" : "Review paragraph by paragraph"} aria-expanded={open}
          className="text-muted-foreground hover:text-foreground">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <button type="button" onClick={() => {
          if (set.info?.threadId) editor.getExtension(CommentsExtension)?.selectThread(set.info.threadId);
          else scrollTo(set.from);
        }} className="min-w-0 flex-1 text-left">
          <span className="block truncate text-xs text-foreground">
            <span style={{ color: SCHOLARPEN_AI.color }}>{SCHOLARPEN_AI.shortName}</span> · {set.info?.label ?? "AI edit"}
          </span>
          <span className="block text-[11px] text-muted-foreground">
            {count} {count === 1 ? "paragraph" : "paragraphs"}
            {coordinated && " · Accept or reject together"}
          </span>
        </button>
        <Button label="Accept" size="sm" variant="secondary" onClick={() => decideChangeSet(editor, set.id, true)} />
        <Button label="Reject" size="sm" variant="ghost" onClick={() => decideChangeSet(editor, set.id, false)} />
      </div>
      {open && set.paragraphs.map((paragraph) => (
        <div key={paragraph.blockId ?? paragraph.from} className="flex items-start gap-1 py-1 pl-8 pr-2 hover:bg-sidebar-accent/60">
          <button type="button" onClick={() => scrollTo(paragraph.from)} className="min-w-0 flex-1 text-left text-xs leading-5">
            {paragraph.deleted && <del className="text-muted-foreground">{paragraph.deleted.slice(0, 160)}</del>}
            {paragraph.deleted && paragraph.inserted && " "}
            {paragraph.inserted && <ins className="no-underline">{paragraph.inserted.slice(0, 160)}</ins>}
          </button>
          {!coordinated && <><IconButton label="Accept this paragraph" icon={<Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden />}
            onClick={() => decideChangeSet(editor, set.id, true, paragraph)} />
          <IconButton label="Reject this paragraph" icon={<X className="h-3.5 w-3.5 text-destructive" aria-hidden />}
            onClick={() => decideChangeSet(editor, set.id, false, paragraph)} /></>}
        </div>
      ))}
    </div>
  );
}
