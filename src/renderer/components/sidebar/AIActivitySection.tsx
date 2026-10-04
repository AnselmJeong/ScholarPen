import React, { useEffect, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { CommentsExtension } from "@blocknote/core/comments";
import { AlertTriangle, Bot, Check, CircleDot, Clock, Pause, Play, ScanSearch, Undo2, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { onCollabActivity, rpc } from "../../rpc";
import { getEditorCollab } from "../../collab/editor-collab";
import { listSuggestions, resolveAllSuggestions, resolveSuggestion, type PendingSuggestion } from "../../collab/suggestions";
import type { AgentActivityMessage, AgentJobView } from "../../../shared/collab/agent-types";
import { REVIEW_MAP, reviewSettingsOf, updateReviewSettings, type ReviewSettings } from "../../../shared/collab/review";
import { DEFAULT_PERSONA_ID, PERSONAS, personaById } from "../../../shared/collab/personas";

function useReviewSettings(editor: BlockNoteEditor<any, any, any>) {
  const collab = getEditorCollab(editor);
  const [settings, setSettings] = useState<ReviewSettings | null>(null);
  useEffect(() => {
    if (!collab) return;
    const map = collab.ydoc.getMap(REVIEW_MAP);
    const refresh = () => setSettings(reviewSettingsOf(map));
    refresh();
    map.observe(refresh);
    return () => map.unobserve(refresh);
  }, [collab]);
  const update = (patch: Partial<ReviewSettings>) => {
    if (!collab) return;
    collab.ydoc.transact(() => updateReviewSettings(collab.ydoc.getMap(REVIEW_MAP), patch));
  };
  return [settings, update] as const;
}

function useAgentActivity(docKey: string | null) {
  const [activity, setActivity] = useState<AgentActivityMessage | null>(null);
  useEffect(() => {
    if (!docKey) return;
    let cancelled = false;
    setActivity(null);
    rpc.collabAgentStatus(docKey)
      .then((status) => { if (!cancelled && status) setActivity(status); })
      .catch(() => undefined);
    const off = onCollabActivity((message) => {
      if (message.docKey === docKey) setActivity(message);
    });
    return () => { cancelled = true; off(); };
  }, [docKey]);
  return activity;
}

function useSuggestions(editor: BlockNoteEditor<any, any, any>) {
  const [suggestions, setSuggestions] = useState<PendingSuggestion[]>([]);
  useEffect(() => {
    const refresh = () => {
      const doc = editor.prosemirrorView?.state.doc;
      setSuggestions(doc ? listSuggestions(doc) : []);
    };
    refresh();
    return editor.onChange(refresh);
  }, [editor]);
  return suggestions;
}

const JOB_ICON: Record<AgentJobView["state"], React.ReactNode> = {
  queued: <Clock className="h-3 w-3 text-muted-foreground" />,
  waiting: <Clock className="h-3 w-3 text-amber-600" />,
  working: <CircleDot className="h-3 w-3 animate-pulse text-violet-600" />,
  done: <Check className="h-3 w-3 text-emerald-600" />,
  failed: <AlertTriangle className="h-3 w-3 text-red-600" />,
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

/** AI work queue and pending suggestions for the active document. */
export function AIActivitySection({ editor }: { editor: BlockNoteEditor<any, any, any> }) {
  const collab = getEditorCollab(editor);
  const activity = useAgentActivity(collab?.docKey ?? null);
  const suggestions = useSuggestions(editor);
  const [showDone, setShowDone] = useState(false);
  const jobs = activity?.jobs ?? [];
  const active = jobs.filter((job) => ["queued", "waiting", "working"].includes(job.state));
  const finished = jobs.filter((job) => !active.includes(job));
  const paused = activity?.paused ?? false;
  const [review, updateReview] = useReviewSettings(editor);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState(DEFAULT_PERSONA_ID);

  const reviewSection = () => {
    if (!collab) return;
    setReviewError(null);
    const blockId = editor.getTextCursorPosition().block.id;
    rpc.collabReviewSection(collab.docKey, blockId, reviewer)
      .catch((error) => setReviewError(error instanceof Error ? error.message : String(error)));
  };

  const scrollTo = (from: number) => {
    const view = editor.prosemirrorView;
    if (!view) return;
    (view.domAtPos(from).node as Element | null)?.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div className="border-b border-border">
      <div className="flex items-center gap-1.5 px-3 py-2">
        <Bot className="h-3.5 w-3.5 text-violet-600" />
        <span className="text-xs font-medium text-foreground">ScholarPen AI</span>
        <span className="text-[11px] text-muted-foreground">
          {paused ? "· paused" : active.length > 0 ? `· ${JOB_STATE[active[0].state].toLowerCase()}` : "· idle"}
        </span>
        <div className="ml-auto flex gap-1">
          <select value={reviewer} onChange={(event) => setReviewer(event.target.value)} aria-label="Reviewer"
            className="rounded border border-border bg-background px-1 text-[11px] text-muted-foreground">
            {PERSONAS.map((persona) => <option key={persona.id} value={persona.id}>{persona.shortName}</option>)}
          </select>
          <IconButton
            label={`Review the section at the cursor as ${personaById(reviewer).name}`}
            disabled={!collab}
            onClick={reviewSection}
            icon={<ScanSearch className="h-3 w-3" />}
          />
          <IconButton
            label={paused ? "Resume AI" : "Pause AI"}
            onClick={() => void rpc.collabSetAgentPaused(!paused)}
            icon={paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
          />
          <IconButton
            label="Undo last AI edit"
            disabled={!activity?.canUndo || !collab}
            onClick={() => collab && void rpc.collabUndoAI(collab.docKey)}
            icon={<Undo2 className="h-3 w-3" />}
          />
        </div>
      </div>

      {review && (
        <div className="flex items-center gap-2 px-3 pb-1.5 text-[11px] text-muted-foreground">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={review.autoReview}
              onChange={(event) => updateReview({ autoReview: event.target.checked })} />
            Review sections I leave
          </label>
          <select value={review.minSeverity} aria-label="Minimum severity"
            onChange={(event) => updateReview({ minSeverity: event.target.value as ReviewSettings["minSeverity"] })}
            className="ml-auto rounded border border-border bg-background px-1 py-0.5 text-[11px]">
            <option value="low">All findings</option>
            <option value="medium">Medium and up</option>
            <option value="high">High only</option>
          </select>
        </div>
      )}
      {review && review.muted.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 px-3 pb-1.5 text-[10px] text-muted-foreground">
          Muted:
          {review.muted.map((category) => (
            <button key={category} type="button" title="Show these findings again"
              onClick={() => updateReview({ muted: review.muted.filter((item) => item !== category) })}
              className="rounded bg-muted px-1 hover:text-foreground">{category} ×</button>
          ))}
        </div>
      )}
      {reviewError && <p className="px-3 pb-1.5 text-[11px] text-red-600">{reviewError}</p>}
      {active.map((job) => (
        <JobRow key={job.id} job={job} editor={editor} />
      ))}
      {finished.length > 0 && (
        <button type="button" onClick={() => setShowDone((value) => !value)}
          className="w-full px-3 pb-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground">
          {showDone ? "Hide" : "Show"} {finished.length} finished
        </button>
      )}
      {showDone && finished.map((job) => <JobRow key={job.id} job={job} editor={editor} />)}

      {suggestions.length > 0 && (
        <div className="border-t border-border">
          <div className="flex items-center gap-1 px-3 py-1.5">
            <span className="mr-auto text-[11px] font-medium text-foreground">
              {suggestions.length} suggested {suggestions.length === 1 ? "change" : "changes"}
            </span>
            <button type="button" onClick={() => resolveAllSuggestions(editor, true)}
              className="rounded px-1.5 py-0.5 text-[11px] text-emerald-700 hover:bg-emerald-500/10">Accept all</button>
            <button type="button" onClick={() => resolveAllSuggestions(editor, false)}
              className="rounded px-1.5 py-0.5 text-[11px] text-red-600 hover:bg-red-500/10">Reject all</button>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {suggestions.map((suggestion) => (
              <div key={String(suggestion.id)} className="group flex items-start gap-2 px-3 py-1.5 hover:bg-muted/50">
                <button type="button" onClick={() => scrollTo(suggestion.from)} className="min-w-0 flex-1 text-left text-[11px] leading-4">
                  {suggestion.deleted && <del className="text-muted-foreground">{suggestion.deleted.slice(0, 120)}</del>}
                  {suggestion.deleted && suggestion.inserted && " "}
                  {suggestion.inserted && <ins className="no-underline">{suggestion.inserted.slice(0, 120)}</ins>}
                </button>
                <IconButton label="Accept" onClick={() => resolveSuggestion(editor, suggestion.id, true)}
                  icon={<Check className="h-3 w-3 text-emerald-700" />} />
                <IconButton label="Reject" onClick={() => resolveSuggestion(editor, suggestion.id, false)}
                  icon={<X className="h-3 w-3 text-red-600" />} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function JobRow({ job, editor }: { job: AgentJobView; editor: BlockNoteEditor<any, any, any> }) {
  const open = () => {
    if (job.threadId) editor.getExtension(CommentsExtension)?.selectThread(job.threadId);
  };
  return (
    <button type="button" onClick={open}
      className="flex w-full items-start gap-1.5 px-3 py-1 text-left hover:bg-muted/50">
      <span className="mt-0.5">{JOB_ICON[job.state]}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] text-foreground">
          {job.agent && job.agent !== DEFAULT_PERSONA_ID ? `${personaById(job.agent).shortName} · ` : ""}
          {job.kind === "review" ? "Review: " : job.kind === "draft" ? "Draft: " : ""}{job.label}
        </span>
        <span className={cn("block text-[10px]", job.state === "failed" ? "text-red-600" : "text-muted-foreground")}>
          {JOB_STATE[job.state]}{job.detail ? ` · ${job.detail}` : ""}
        </span>
      </span>
    </button>
  );
}

function IconButton({ label, icon, onClick, disabled }: {
  label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick}
      className="rounded border border-border p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
      {icon}
    </button>
  );
}
