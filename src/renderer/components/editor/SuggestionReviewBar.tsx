import React, { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { BlockNoteEditor } from "@blocknote/core";
import { ChevronLeft, ChevronRight, Eye, EyeOff, X } from "lucide-react";
import { getEditorCollab } from "../../collab/editor-collab";
import { decideAllChangeSets, decideChangeSet } from "../../collab/use-change-sets";
import { useAgentActivity } from "../../collab/use-agent-activity";
import type { ReviewStore } from "../../collab/suggestion-review";
import type { SuggestionHunk } from "../../collab/suggestion-hunks";
import { hunkDecisionRange } from "../../collab/margin-review-layout";
import { CHANGE_SETS_MAP, type ChangeSetInfo } from "../../../shared/collab/change-sets";
import { REVISIONS_MAP, type RevisionEntry } from "../../../shared/collab/revision-log";

function useStore(store: ReviewStore) {
  return useSyncExternalStore(store.subscribe, () => store.version);
}

/** What the AI said it did for each pending change set: the revision summary, else the request. */
function useChangeSetSummaries(editor: BlockNoteEditor<any, any, any>) {
  const collab = getEditorCollab(editor);
  const [summaries, setSummaries] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!collab) return;
    const infos = collab.ydoc.getMap<ChangeSetInfo>(CHANGE_SETS_MAP);
    const revisions = collab.ydoc.getMap<RevisionEntry>(REVISIONS_MAP);
    const refresh = () => {
      const next = new Map<string, string>();
      for (const [id, info] of infos.entries()) next.set(id, info.label);
      for (const entry of revisions.values()) {
        if (entry.changeSetId !== undefined && entry.summary?.trim()) next.set(String(entry.changeSetId), entry.summary.trim());
      }
      setSummaries(next);
    };
    refresh();
    infos.observe(refresh);
    revisions.observe(refresh);
    return () => { infos.unobserve(refresh); revisions.unobserve(refresh); };
  }, [collab]);
  return summaries;
}

/** BlockNote's own AI menu reviews its suggestions itself; stay out of its way. */
function useBlockNoteAIMenuOpen(editor: BlockNoteEditor<any, any, any>) {
  const ai = editor.getExtension("ai") as { store?: { state: { aiMenuState: unknown }; subscribe(cb: () => void): () => void } } | undefined;
  const [open, setOpen] = useState(() => ai?.store?.state.aiMenuState !== undefined && ai?.store?.state.aiMenuState !== "closed");
  useEffect(() => {
    const store = ai?.store;
    if (!store) return;
    const update = () => setOpen(store.state.aiMenuState !== "closed");
    update();
    const off = store.subscribe(update);
    return typeof off === "function" ? off : undefined;
  }, [ai]);
  return open;
}

/** The part of a change that is on screen: removed text is hidden in the clean view. */
function visibleRange(hunk: SuggestionHunk) {
  const first = hunk.insertions[0];
  const last = hunk.insertions.at(-1);
  return first && last ? { from: first.from, to: last.to } : { from: hunk.to, to: hunk.to };
}

function scrollToHunk(editor: BlockNoteEditor<any, any, any>, hunk: SuggestionHunk) {
  const view = editor.prosemirrorView;
  if (!view) return;
  try {
    const { node } = view.domAtPos(visibleRange(hunk).from);
    const element = node instanceof Element ? node : node.parentElement;
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch { /* the position moved under us; nothing to scroll to */ }
}

/**
 * Bottom bar for pending AI changes, after the "agent edits in place" pattern:
 * what the AI did, how many changes, step through them, keep or revert all.
 * While the AI is working it shows what it is doing instead.
 */
export function SuggestionReviewBar({ editor, store, scrollContainer, showPopover = true }: {
  editor: BlockNoteEditor<any, any, any>;
  store: ReviewStore;
  scrollContainer: HTMLElement | null;
  showPopover?: boolean;
}) {
  useStore(store);
  const { hunks, active, mode, arriving } = store;
  const summaries = useChangeSetSummaries(editor);
  const activity = useAgentActivity(getEditorCollab(editor)?.docKey ?? null);
  const aiMenuOpen = useBlockNoteAIMenuOpen(editor);
  const [summaryHidden, setSummaryHidden] = useState<string | null>(null);

  const working = activity?.jobs.find((job) => job.state === "working");
  const count = hunks.length;
  const index = active !== null && active < count ? active : null;
  const current = index !== null ? hunks[index] : null;
  const setIds = useMemo(() => [...new Set(hunks.map((hunk) => String(hunk.id)))], [hunks]);
  const focusId = current ? String(current.id) : setIds.at(-1);
  const summary = focusId ? summaries.get(focusId) : undefined;

  // Keep the selection inside the list as changes are kept or reverted.
  useEffect(() => {
    if (store.active !== null && store.active >= count) store.set(count ? { active: count - 1 } : { active: null, open: false });
  }, [count, store]);

  useEffect(() => {
    if (!store.open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") store.set({ open: false }); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, store.open]);

  if (aiMenuOpen) return null;

  const go = (step: number) => {
    if (!count) return;
    const from = store.active !== null && store.active < count ? store.active : null;
    const next = from === null ? (step > 0 ? 0 : count - 1) : (from + step + count) % count;
    store.set({ active: next, open: true });
    // Wide layouts reveal the packed margin card; competing source scrolling
    // could move that card off screen again while its smooth scroll is running.
    if (showPopover) scrollToHunk(editor, store.hunks[next]);
  };

  if (!count) {
    if (!working) return null;
    return (
      <div className="sp-review-bar flex items-center gap-2 px-3 py-2" role="status" aria-live="polite">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500 animate-pulse" />
        <span className="truncate">
          <span className="font-medium">ScholarPen AI</span>
          <span className="text-muted-foreground"> · {working.detail || working.label}</span>
        </span>
      </div>
    );
  }

  const showSummary = summary && summaryHidden !== `${focusId}:${summary}`;
  return (
    <>
      <div className="sp-review-bar px-3 py-2" role="region" aria-label="Pending AI changes">
        {arriving > 0 ? (
          <div className="flex items-center gap-2 pb-1.5" role="status" aria-live="polite">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500 animate-pulse" />
            <span className="text-muted-foreground">Writing {arriving} {arriving === 1 ? "change" : "changes"}…</span>
          </div>
        ) : showSummary ? (
          <div className="flex items-start gap-2 pb-1.5">
            <span className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" />
            <p className="min-w-0 flex-1 leading-snug line-clamp-2" title={summary}>{summary}</p>
            <button type="button" className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
              aria-label="Hide summary" onClick={() => setSummaryHidden(`${focusId}:${summary}`)}>
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : null}
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          <span className="font-semibold">{count} {count === 1 ? "change" : "changes"}</span>
          {setIds.length > 1 && <span className="text-muted-foreground">· {setIds.length} requests</span>}
          <button type="button" className="ml-1 rounded p-1 hover:bg-muted" aria-label="Previous change" onClick={() => go(-1)}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          {index !== null && <span className="tabular-nums text-muted-foreground">{index + 1} of {count}</span>}
          <button type="button" className="rounded p-1 hover:bg-muted" aria-label="Next change" onClick={() => go(1)}>
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button type="button" className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-pressed={mode === "markup"}
            title={mode === "clean" ? "Show removed text inline" : "Hide removed text"}
            onClick={() => store.set({ mode: mode === "clean" ? "markup" : "clean" })}>
            {mode === "clean" ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            {mode === "clean" ? "Markup" : "Clean"}
          </button>
          <span className="flex-1" />
          <button type="button" className="rounded-full px-2.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => { store.set({ open: false }); decideAllChangeSets(editor, false); }}>
            Revert all
          </button>
          <button type="button" className="rounded-full bg-primary px-3 py-1 font-medium text-primary-foreground hover:opacity-90"
            onClick={() => { store.set({ open: false }); decideAllChangeSets(editor, true); }}>
            Keep all
          </button>
        </div>
      </div>
      {showPopover && store.open && current && (
        <HunkPopover key={`${index}-${current.from}`} editor={editor} hunk={current} scrollContainer={scrollContainer}
          onDecide={(accept) => decideChangeSet(editor, current.id, accept, hunkDecisionRange(current))}
          onClose={() => store.set({ open: false })} />
      )}
    </>
  );
}

/** One change: the original text it replaced, and Keep / Revert for just this change. */
function HunkPopover({ editor, hunk, scrollContainer, onDecide, onClose }: {
  editor: BlockNoteEditor<any, any, any>;
  hunk: SuggestionHunk;
  scrollContainer: HTMLElement | null;
  onDecide: (accept: boolean) => void;
  onClose: () => void;
}) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const view = editor.prosemirrorView;
      if (!view || view.isDestroyed) return;
      try {
        const visible = visibleRange(hunk);
        const start = view.coordsAtPos(visible.from, 1);
        const end = view.coordsAtPos(visible.to, -1);
        const bounds = scrollContainer?.getBoundingClientRect();
        const bottom = Math.max(start.bottom, end.bottom);
        const width = Math.min(300, (bounds?.width ?? window.innerWidth) - 16);
        const left = Math.min(Math.max(start.left - 10, (bounds?.left ?? 0) + 8), (bounds?.right ?? window.innerWidth) - width - 8);
        const hidden = bounds && (bottom < bounds.top || start.top > bounds.bottom);
        setPosition(hidden ? null : { top: Math.max((bounds?.top ?? 0) + 8, Math.min(bottom + 6, (bounds?.bottom ?? window.innerHeight) - 200)), left });
      } catch {
        setPosition(null);
      }
    };
    place();
    const target = scrollContainer ?? window;
    target.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    return () => {
      target.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [editor, hunk, scrollContainer]);

  if (!position) return null;
  const deleted = hunk.deleted.trim();
  return createPortal(
    <div className="sp-review-popover" style={position} role="dialog" aria-label="AI change">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 max-h-40 overflow-y-auto">
          {deleted
            ? <del>{hunk.deleted}</del>
            : <span className="text-muted-foreground">Added by ScholarPen AI — nothing was removed here.</span>}
        </div>
        <button type="button" className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted" aria-label="Close" onClick={onClose}>
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-[11px]">
        <button type="button" className="font-medium hover:underline" onClick={() => onDecide(true)}>Keep</button>
        <button type="button" className="text-muted-foreground hover:text-foreground hover:underline" onClick={() => onDecide(false)}>Revert</button>
      </div>
    </div>, document.body,
  );
}
