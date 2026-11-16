import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { BlockNoteEditor } from "@blocknote/core";
import { CommentsExtension } from "@blocknote/core/comments";
import { useThreads } from "@blocknote/react";
import { Check, ChevronDown, ChevronUp, MessageSquare, X } from "lucide-react";
import type { CollabPeer } from "../../collab/collab-peer";
import { MarginThread } from "./MarginThread";
import { ProposalCard, type ProposalItem } from "./ProposalCard";
import type { ReviewStore } from "../../collab/suggestion-review";
import type { SuggestionHunk } from "../../collab/suggestion-hunks";
import { decideChangeSet } from "../../collab/use-change-sets";
import { hunkDecisionRange, packMarginCards } from "../../collab/margin-review-layout";
import { COLLAB_THREADS_MAP } from "../../../shared/collab/protocol";
import { readThreads, updateThreadMeta, type ThreadSnapshot } from "../../../shared/collab/threads";
import { REVIEW_MAP, isDisabledReviewType, reviewSettingsOf } from "../../../shared/collab/review";
import { isAIUser } from "../../../shared/collab/personas";
import { OPEN_PROPOSAL_STATES, readProposalEntries, REVIEW_PROPOSALS_MAP, type ProposalEntry } from "../../../shared/collab/review-proposals";
import { REVISIONS_MAP } from "../../../shared/collab/revision-log";
import { proposalChangeSet, syncProposalStates } from "../../collab/review-proposals";
import { takeProposalFocus, subscribeProposalFocus } from "../../collab/proposal-focus";

type Editor = BlockNoteEditor<any, any, any>;
type Annotation = { key: string; from: number; to: number; number: number } & (
  | { kind: "edit"; hunk: SuggestionHunk; index: number }
  | { kind: "comment"; thread: ThreadSnapshot }
  | ({ kind: "proposal" } & ProposalItem)
);
const KIND_LABEL = { edit: "Edit", comment: "Comment", proposal: "Reviewer revision" } as const;

/** Start of a block's own text, for proposals that have no tracked change to anchor to. */
function blockTextStart(editor: Editor, blockId: string) {
  let found: number | null = null;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === "blockContainer" && node.attrs.id === blockId) { found = pos + 2; return false; }
    return true;
  });
  return found as number | null;
}
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
  const [selectedProposal, setSelectedProposal] = useState<string | null>(null);

  useEffect(() => {
    const threads = peer.ydoc.getMap(COLLAB_THREADS_MAP);
    const settings = peer.ydoc.getMap(REVIEW_MAP);
    const proposals = peer.ydoc.getMap(REVIEW_PROPOSALS_MAP);
    const revisions = peer.ydoc.getMap(REVISIONS_MAP);
    const refresh = () => setRevision(n => n + 1);
    threads.observeDeep(refresh);
    settings.observe(refresh);
    proposals.observe(refresh);
    revisions.observe(refresh);
    return () => { threads.unobserveDeep(refresh); settings.unobserve(refresh); proposals.unobserve(refresh); revisions.unobserve(refresh); };
  }, [peer]);

  // Review & Revision proposals: one card per proposal, over all of its tracked changes.
  const proposalItems = useMemo(() => {
    const threads = readThreads(peer.ydoc.getMap(COLLAB_THREADS_MAP));
    const entries = readProposalEntries(peer.ydoc.getMap<ProposalEntry>(REVIEW_PROPOSALS_MAP));
    return { entries, threads, items: entries.filter(entry => OPEN_PROPOSAL_STATES.has(entry.state)).map(entry => {
      const thread = entry.threadId ? threads.find(item => item.id === entry.threadId) : undefined;
      const changeSetId = proposalChangeSet(entry, thread);
      const hunks = changeSetId === undefined ? [] : store.hunks.filter(hunk => String(hunk.id) === String(changeSetId));
      return { entry, thread, changeSetId, hunks } satisfies ProposalItem;
    }) };
  }, [peer, store, version, revision]);
  const peerIds = useMemo(() => new Set(proposalItems.items.flatMap(item => item.changeSetId === undefined ? [] : [String(item.changeSetId)])),
    [proposalItems]);
  useEffect(() => {
    const same = peerIds.size === store.peer.size && [...peerIds].every(id => store.peer.has(id));
    if (!same) store.set({ peer: peerIds });
  }, [peerIds, store]);
  // Decisions made from the review bar or Activity settle the proposal too.
  useEffect(() => { syncProposalStates(peer.ydoc, proposalItems.entries, proposalItems.threads); }, [peer, proposalItems]);

  const items = useMemo<Annotation[]>(() => {
    const muted = reviewSettingsOf(peer.ydoc.getMap(REVIEW_MAP)).muted;
    const edits: Annotation[] = store.hunks.flatMap((hunk, index) => peerIds.has(String(hunk.id)) ? [] : [{
      key: `edit:${hunk.id}:${hunk.from}`, kind: "edit" as const, hunk, index, number: 0,
      from: hunk.insertions[0]?.from ?? hunk.to,
      to: hunk.insertions[0]?.to ?? hunk.to,
    }]);
    const proposals: Annotation[] = proposalItems.items.flatMap(item => {
      const first = item.hunks[0];
      // A proposal decided elsewhere, or not yet arrived, has nothing to point at.
      if (!first && item.entry.state === "pending") return [];
      const from = first ? first.insertions[0]?.from ?? first.to : blockTextStart(editor, item.entry.blockId);
      if (from === null) return [];
      return [{ ...item, key: `proposal:${item.entry.key}`, kind: "proposal" as const, number: 0,
        from, to: first ? first.insertions[0]?.to ?? first.to : from }];
    });
    const notes: Annotation[] = readThreads(peer.ydoc.getMap(COLLAB_THREADS_MAP)).flatMap(thread => {
      const range = commentState.threadPositions.get(thread.id);
      // Whole-document requests and detached comments stay in Activity, without a false anchor.
      // A request for another version of a reviewer revision is shown on the proposal's card.
      if (!range || thread.meta.scope === "document" || thread.meta.reviewProposal || thread.resolved || thread.meta.status === "resolved" ||
          thread.meta.muted || isDisabledReviewType(thread.meta.category, muted) ||
          !thread.comments.some(comment => !comment.deleted)) return [];
      return [{ key: `comment:${thread.id}`, kind: "comment" as const, thread, ...range, number: 0 }];
    });
    return [...edits, ...proposals, ...notes].sort((a, b) => a.from - b.from || a.key.localeCompare(b.key))
      .map((item, index) => ({ ...item, number: index + 1 }));
  }, [editor, peer, store, version, revision, commentState.threadPositions, proposalItems, peerIds]);

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
    : item.kind === "proposal" ? selectedProposal === item.entry.key
      : commentState.selectedThreadId === item.thread.id;
  const select = (item: Annotation, scroll = false) => {
    // The card header explicitly asks to reveal the source, not the card.
    if (scroll && wide) revealedSelection.current = item.key;
    if (item.kind === "edit") {
      setSelectedProposal(null);
      comments.selectThread(undefined);
      store.set({ active: item.index, open: true });
    } else if (item.kind === "proposal") {
      comments.selectThread(undefined);
      const first = item.hunks[0] ? store.hunks.indexOf(item.hunks[0]) : -1;
      store.set({ active: first >= 0 ? first : null, open: false });
      setSelectedProposal(item.entry.key);
    } else {
      setSelectedProposal(null);
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
    if (commentState.selectedThreadId) { store.set({ active: null, open: false }); setSelectedProposal(null); }
  }, [commentState.selectedThreadId]);
  // Clicking a reviewer revision's redline in the text, or stepping onto it, selects its card.
  useEffect(() => {
    if (!store.open || store.active === null) return;
    const hunk = store.hunks[store.active];
    const item = hunk && items.find(entry => entry.kind === "proposal" && entry.hunks.includes(hunk));
    if (item) select(item);
    else setSelectedProposal(null);
  }, [store.open, store.active]);
  // "Show in manuscript" from the Review & Revision workspace selects the proposal's card.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    const reveal = () => {
      const target = takeProposalFocus(peer.docKey, key => itemsRef.current.some(item => item.kind === "proposal" && item.entry.key === key));
      const item = target && itemsRef.current.find(item => item.kind === "proposal" && item.entry.key === target);
      if (item) requestAnimationFrame(() => select(item, true));
    };
    reveal();
    return subscribeProposalFocus(reveal);
  }, [peer, items.length]);
  useEffect(() => {
    if (store.open && comments.store.state.selectedThreadId) comments.selectThread(undefined);
  }, [store.open, store.active, comments]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      comments.selectThread(undefined);
      store.set({ open: false });
      setExpanded(null);
      setSelectedProposal(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [comments, store]);

  const selectedKey = commentState.selectedThreadId ? `comment:${commentState.selectedThreadId}`
    : selectedProposal ? `proposal:${selectedProposal}`
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
        const label = members.map(item => `${KIND_LABEL[item.kind]} ${item.number}`).join(", ");
        return <button key={group[0].key} type="button" className="sp-margin-anchor" data-kind={item.kind} data-active={selected >= 0}
          style={{ left: group[0].x, top: group[0].anchor - 10 }} aria-label={`${label}: select margin card`}
          title={members.length > 1 ? `${label} — click to cycle` : label} aria-pressed={selected >= 0}
          onClick={() => select(members[(selected + 1) % members.length])}>
          {members.length <= 2 ? members.map(item => item.number).join("·") : `${item.number}+`}
        </button>;
      })}
      {visible && items.map(item => {
        const position = positions.find(position => position.key === item.key);
        const label = `${KIND_LABEL[item.kind]} ${item.number}`;
        const selected = active(item);
        const first = item.kind === "comment" ? item.thread.comments.find(comment => !comment.deleted) : null;
        return <React.Fragment key={item.key}>
          {wide ? (
            <section ref={node => { if (node) cards.current.set(item.key, node); else cards.current.delete(item.key); }}
              className="sp-margin-card" data-kind={item.kind} data-active={selected}
              style={{ top: position?.top ?? 0, visibility: position ? "visible" : "hidden" }} aria-label={label}>
              {item.kind === "proposal" ? <ProposalCard editor={editor} item={item} number={item.number} selected={selected}
                onSelect={scroll => select(item, scroll)} /> : <>
              <div className="sp-margin-card-header">
                <button type="button" className="sp-margin-title" onClick={() => select(item, true)}
                  aria-label={`${label}: show in text`} aria-pressed={selected}>
                  <span className="sp-margin-number">{item.number}</span>
                  {/* The AI's own review notes are not answers to the journal's reviewers. */}
                  <span>{item.kind === "edit" ? "Revision" : first && isAIUser(first.userId) ? "AI review" : "Comment"}</span>
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
              </>}
            </section>
          ) : (
            <button type="button" className="sp-margin-pin" data-kind={item.kind} data-active={selected}
              style={{ top: position?.top ?? 0, visibility: position ? "visible" : "hidden" }}
              aria-label={`${label}: show details`} aria-pressed={selected}
              onClick={() => item.kind === "proposal" && selected ? setSelectedProposal(null) : select(item, true)}>{item.number}</button>
          )}
          {/* A narrow margin has only pins; the selected reviewer revision opens beside its pin. */}
          {!wide && item.kind === "proposal" && selected && position && (
            <section className="sp-margin-card sp-margin-card-floating" data-kind="proposal" data-active="true"
              style={{ top: position.top }} aria-label={label}>
              <ProposalCard editor={editor} item={item} number={item.number} selected onSelect={scroll => select(item, scroll)} />
              {/* The header's × rejects the proposal; closing the card is separate. */}
              <button type="button" className="sp-margin-link" onClick={() => setSelectedProposal(null)}>
                <ChevronUp size={12} /> 카드 닫기
              </button>
            </section>
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
