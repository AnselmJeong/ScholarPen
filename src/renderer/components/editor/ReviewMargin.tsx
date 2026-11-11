import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { BlockNoteEditor } from "@blocknote/core";
import { CommentsExtension } from "@blocknote/core/comments";
import { useThreads } from "@blocknote/react";
import { Check, ChevronDown, ChevronUp, MessageSquare, X } from "lucide-react";
import type { CollabPeer } from "../../collab/collab-peer";
import { MarginThread } from "./MarginThread";
import type { ReviewStore } from "../../collab/suggestion-review";
import type { SuggestionHunk } from "../../collab/suggestion-hunks";
import { decideChangeSet } from "../../collab/use-change-sets";
import { hunkDecisionRange, packMarginCards } from "../../collab/margin-review-layout";
import { COLLAB_THREADS_MAP } from "../../../shared/collab/protocol";
import { readThreads, updateThreadMeta, type ThreadSnapshot } from "../../../shared/collab/threads";
import { REVIEW_MAP, isDisabledReviewType, reviewSettingsOf } from "../../../shared/collab/review";

type Editor = BlockNoteEditor<any, any, any>;
type Annotation = { key: string; from: number; to: number; number: number } & (
  | { kind: "edit"; hunk: SuggestionHunk; index: number }
  | { kind: "comment"; thread: ThreadSnapshot }
);
type Position = { key: string; top: number; anchor: number; x: number; height: number };
export type MarginPresentation = { count: number; wide: boolean };

/** Mounted inside BlockNote's providers; the portal preserves reply/editor context. */
export function ReviewMargin({ editor, peer, store, canvasRef, scrollRef, visible, onPresentationChange }: {
  editor: Editor;
  peer: CollabPeer;
  store: ReviewStore;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  onPresentationChange: (value: MarginPresentation) => void;
}) {
  const version = useSyncExternalStore(store.subscribe, () => store.version);
  const comments = editor.getExtension(CommentsExtension)!;
  const commentState = useSyncExternalStore(
    (cb) => comments.store.subscribe(cb), () => comments.store.state,
  );
  const nativeThreads = useThreads();
  const [revision, setRevision] = useState(0);
  const [wide, setWide] = useState(false);
  const [positions, setPositions] = useState<Position[]>([]);
  const cards = useRef(new Map<string, HTMLElement>());
  const [expanded, setExpanded] = useState<string | null>(null);
  const threadSlot = useRef<HTMLDivElement>(null);
  const [threadHeight, setThreadHeight] = useState(180);
  const revealedSelection = useRef<string | undefined>(undefined);

  useEffect(() => {
    const threads = peer.ydoc.getMap(COLLAB_THREADS_MAP);
    const settings = peer.ydoc.getMap(REVIEW_MAP);
    const refresh = () => setRevision(n => n + 1);
    threads.observeDeep(refresh);
    settings.observe(refresh);
    return () => { threads.unobserveDeep(refresh); settings.unobserve(refresh); };
  }, [peer]);

  const items = useMemo<Annotation[]>(() => {
    const muted = reviewSettingsOf(peer.ydoc.getMap(REVIEW_MAP)).muted;
    const edits: Annotation[] = store.hunks.map((hunk, index) => ({
      key: `edit:${hunk.id}:${hunk.from}`, kind: "edit", hunk, index, number: 0,
      from: hunk.insertions[0]?.from ?? hunk.to,
      to: hunk.insertions[0]?.to ?? hunk.to,
    }));
    const notes: Annotation[] = readThreads(peer.ydoc.getMap(COLLAB_THREADS_MAP)).flatMap(thread => {
      const range = commentState.threadPositions.get(thread.id);
      // Whole-document requests and detached comments stay in Activity, without a false anchor.
      if (!range || thread.meta.scope === "document" || thread.resolved || thread.meta.status === "resolved" ||
          thread.meta.muted || isDisabledReviewType(thread.meta.category, muted) ||
          !thread.comments.some(comment => !comment.deleted)) return [];
      return [{ key: `comment:${thread.id}`, kind: "comment" as const, thread, ...range, number: 0 }];
    });
    return [...edits, ...notes].sort((a, b) => a.from - b.from || a.key.localeCompare(b.key))
      .map((item, index) => ({ ...item, number: index + 1 }));
  }, [peer, store, version, revision, commentState.threadPositions]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const measure = () => setWide(scroll.clientWidth >= 780);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [scrollRef, items.length]);

  const threadInMargin = items.some(item => item.kind === "comment" && item.thread.id === commentState.selectedThreadId);
  useEffect(() => onPresentationChange({ count: items.length, wide }), [items.length, wide, onPresentationChange]);

  // Positions are in the manuscript's scroll content, so text, leaders and cards scroll together.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const view = editor.prosemirrorView;
    if (!canvas || !view || !visible || !items.length) { setPositions([]); return; }
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (view.isDestroyed) return;
      const bounds = canvas.getBoundingClientRect();
      const measured = items.flatMap(item => {
        try {
          const start = view.coordsAtPos(item.from, 1);
          // Leaders begin outside the text column, so they never cross the rest of a sentence.
          const x = view.dom.getBoundingClientRect().right - parseFloat(getComputedStyle(view.dom).paddingRight || "0") + 4;
          let anchor = (start.top + start.bottom) / 2;
          if (item.to > item.from) {
            const from = view.domAtPos(item.from);
            const to = view.domAtPos(item.to);
            const range = document.createRange();
            range.setStart(from.node, from.offset);
            range.setEnd(to.node, to.offset);
            const line = Array.from(range.getClientRects()).find(rect => rect.width > 0 && rect.height > 0);
            if (line) anchor = (line.top + line.bottom) / 2;
          }
          return [{ key: item.key, x: x - bounds.left + 5, anchor: anchor - bounds.top,
            height: wide ? cards.current.get(item.key)?.offsetHeight || 140 : 26 }];
        } catch { return []; } // A remote transaction may remove an anchor before React rerenders.
      });
      const next = packMarginCards(measured, wide ? 12 : 6).map(item => ({ ...item, x: measured.find(m => m.key === item.key)!.x }));
      setPositions(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    observer.observe(view.dom);
    cards.current.forEach(card => observer.observe(card));
    const mutations = new MutationObserver(schedule);
    mutations.observe(view.dom, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "style"] });
    const off = editor.onChange(schedule);
    window.addEventListener("resize", schedule);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); mutations.disconnect(); off(); window.removeEventListener("resize", schedule); };
  }, [editor, items, wide, visible, expanded, commentState.selectedThreadId, canvasRef]);

  const active = (item: Annotation) => item.kind === "edit"
    ? store.open && store.active === item.index
    : commentState.selectedThreadId === item.thread.id;
  const select = (item: Annotation, scroll = false) => {
    // The card header explicitly asks to reveal the source, not the card.
    if (scroll && wide) revealedSelection.current = item.key;
    if (item.kind === "edit") {
      comments.selectThread(undefined);
      store.set({ active: item.index, open: true });
    } else {
      store.set({ active: null, open: false });
      comments.selectThread(item.thread.id, false);
    }
    if (scroll) {
      try {
        const { node } = editor.prosemirrorView.domAtPos(item.from);
        (node instanceof Element ? node : node.parentElement)?.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch { /* anchor moved */ }
    }
  };

  // Prevent simultaneous comment and revision selection when a source highlight is clicked.
  useEffect(() => {
    if (commentState.selectedThreadId) store.set({ active: null, open: false });
  }, [commentState.selectedThreadId]);
  useEffect(() => {
    if (store.open && comments.store.state.selectedThreadId) comments.selectThread(undefined);
  }, [store.open, store.active, comments]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      comments.selectThread(undefined);
      store.set({ open: false });
      setExpanded(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [comments, store]);

  const selectedKey = commentState.selectedThreadId ? `comment:${commentState.selectedThreadId}`
    : store.open && store.active !== null ? items.find(item => item.kind === "edit" && item.index === store.active)?.key : undefined;
  useEffect(() => {
    if (!visible || !wide || !selectedKey) { revealedSelection.current = undefined; return; }
    if (revealedSelection.current === selectedKey || !positions.some(position => position.key === selectedKey)) return;
    // Wait for measured positions to commit before revealing a crowded card.
    // Reveal once per selection so typing a reply never pulls the page around.
    let revealFrame = 0;
    const frame = requestAnimationFrame(() => {
      revealFrame = requestAnimationFrame(() => {
        const card = cards.current.get(selectedKey);
        const bounds = scrollRef.current?.getBoundingClientRect();
        const box = card?.getBoundingClientRect();
        if (!card || !box || !bounds) return;
        revealedSelection.current = selectedKey;
        if (box.top < bounds.top || box.bottom > bounds.bottom) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(revealFrame); };
  }, [selectedKey, positions, visible, wide, scrollRef]);

  const canvas = canvasRef.current;
  if (!canvas) return null;
  const selectedThread = commentState.selectedThreadId ? nativeThreads.get(commentState.selectedThreadId) : undefined;
  const height = Math.max(0, ...positions.map(p => p.top + p.height + 24));
  // Several edits/comments can refer to the same line. Share a source badge
  // instead of drawing inaccessible buttons on top of one another.
  const anchorGroups: Position[][] = [];
  for (const position of positions) {
    const last = anchorGroups.at(-1);
    if (last && Math.abs(last[0].anchor - position.anchor) < 20) last.push(position);
    else anchorGroups.push([position]);
  }
  return createPortal(
    <aside className="bn-container sp-review-margin" aria-label="Manuscript comments and edits" style={{ height }}>
      <svg className="sp-margin-leaders" aria-hidden="true" width="100%" height={height}>
        {visible && positions.map(position => {
          const item = items.find(item => item.key === position.key)!;
          if (!item) return null;
          const end = canvas.clientWidth - (wide ? 248 : 28);
          const x = Math.min(position.x + (wide ? 20 : 0), end - 6);
          return <path key={position.key} data-kind={item.kind} data-active={active(item)}
            d={`M ${x} ${position.anchor} C ${end - 20} ${position.anchor}, ${end - 20} ${position.top + 18}, ${end} ${position.top + 18}`} />;
        })}
      </svg>
      {visible && wide && anchorGroups.map(group => {
        const members = group.map(position => items.find(item => item.key === position.key)).filter((item): item is Annotation => !!item);
        if (!members.length) return null;
        const selected = members.findIndex(active);
        const item = members[selected >= 0 ? selected : 0];
        const label = members.map(item => `${item.kind === "edit" ? "Edit" : "Comment"} ${item.number}`).join(", ");
        return <button key={group[0].key} type="button" className="sp-margin-anchor" data-kind={item.kind} data-active={selected >= 0}
          style={{ left: group[0].x, top: group[0].anchor - 10 }} aria-label={`${label}: select margin card`}
          title={members.length > 1 ? `${label} — click to cycle` : label} aria-pressed={selected >= 0}
          onClick={() => select(members[(selected + 1) % members.length])}>
          {members.length <= 2 ? members.map(item => item.number).join("·") : `${item.number}+`}
        </button>;
      })}
      {visible && items.map(item => {
        const position = positions.find(position => position.key === item.key);
        const label = `${item.kind === "edit" ? "Edit" : "Comment"} ${item.number}`;
        const selected = active(item);
        const first = item.kind === "comment" ? item.thread.comments.find(comment => !comment.deleted) : null;
        return <React.Fragment key={item.key}>
          {wide ? (
            <section ref={node => { if (node) cards.current.set(item.key, node); else cards.current.delete(item.key); }}
              className="sp-margin-card" data-kind={item.kind} data-active={selected}
              style={{ top: position?.top ?? 0, visibility: position ? "visible" : "hidden" }} aria-label={label}>
              <div className="sp-margin-card-header">
                <button type="button" className="sp-margin-title" onClick={() => select(item, true)}
                  aria-label={`${label}: show in text`} aria-pressed={selected}>
                  <span className="sp-margin-number">{item.number}</span>
                  <span>{item.kind === "edit" ? "Revision" : "Review"}</span>
                  {item.kind === "edit" && <span className="sp-margin-detail">· {item.hunk.deleted ? "Original" : "Addition"}</span>}
                </button>
                {item.kind === "edit" ? <>
                  <button type="button" className="sp-margin-action" aria-label={`Accept edit ${item.number}`} title="Accept this edit"
                    onClick={() => decideChangeSet(editor, item.hunk.id, true, hunkDecisionRange(item.hunk))}><Check size={14} /></button>
                  <button type="button" className="sp-margin-action" aria-label={`Reject edit ${item.number}`} title="Reject this edit"
                    onClick={() => decideChangeSet(editor, item.hunk.id, false, hunkDecisionRange(item.hunk))}><X size={14} /></button>
                </> : <>
                  <button type="button" className="sp-margin-action" aria-label={`Resolve comment ${item.number}`} title="Resolve comment"
                    onClick={() => peer.ydoc.transact(() => updateThreadMeta(peer.ydoc.getMap(COLLAB_THREADS_MAP), item.thread.id, { status: "resolved" }))}><Check size={14} /></button>
                  {selected && <button type="button" className="sp-margin-action" aria-label={`Close comment ${item.number}`} title="Close thread"
                    onClick={() => comments.selectThread(undefined)}><X size={14} /></button>}
                </>}
              </div>
              {item.kind === "edit" ? <>
                <div className="sp-margin-excerpt">{item.hunk.deleted ? <del>{item.hunk.deleted}</del> : <ins>{item.hunk.inserted}</ins>}</div>
                {!!item.hunk.deleted && !!item.hunk.inserted && <>
                  <button className="sp-margin-link" type="button" aria-expanded={expanded === item.key}
                    onClick={() => setExpanded(expanded === item.key ? null : item.key)}>
                    {expanded === item.key ? <ChevronUp size={12} /> : <ChevronDown size={12} />} Revised text
                  </button>
                  {expanded === item.key && <div className="sp-margin-excerpt"><ins>{item.hunk.inserted}</ins></div>}
                </>}
                {!item.hunk.inserted && <p className="sp-margin-detail">Removed from the revised text</p>}
              </> : selected && nativeThreads.get(item.thread.id) ? (
                <div ref={threadSlot} className="sp-margin-thread-slot" style={{ height: threadHeight }} />
              ) : <>
                <button type="button" className="sp-margin-comment" onClick={() => select(item)}>{first?.text}</button>
                <button type="button" className="sp-margin-link" onClick={() => select(item)}>
                  <MessageSquare size={12} /> {item.thread.comments.filter(comment => !comment.deleted).length > 1 ? "Open thread" : "Reply"}
                  {item.thread.meta.status === "in-progress" && <span>· AI working</span>}
                </button>
              </>}
            </section>
          ) : (
            <button type="button" className="sp-margin-pin" data-kind={item.kind} data-active={selected}
              style={{ top: position?.top ?? 0, visibility: position ? "visible" : "hidden" }}
              aria-label={`${label}: show details`} aria-pressed={selected} onClick={() => select(item, true)}>{item.number}</button>
          )}
        </React.Fragment>;
      })}
      {/* Extends scroll content for stacked cards at the document end. */}
      <div className="sp-margin-tail" style={{ top: height }} />
      {selectedThread && !selectedThread.resolved && <MarginThread editor={editor} thread={selectedThread}
        slotRef={threadSlot} scrollRef={scrollRef} embedded={visible && wide && threadInMargin}
        layoutKey={positions} range={commentState.threadPositions.get(selectedThread.id)}
        onHeight={setThreadHeight} onClose={() => comments.selectThread(undefined)} />}
    </aside>, canvas,
  );
}
