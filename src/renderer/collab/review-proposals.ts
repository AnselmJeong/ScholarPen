import type { BlockNoteEditor } from "@blocknote/core";
import { TextSelection } from "prosemirror-state";
import type * as Y from "yjs";
import { COLLAB_THREADS_MAP } from "../../shared/collab/protocol";
import { addThreadComment, createThread, LOCAL_USER_ID, readThreads, updateThreadMeta, type ThreadSnapshot } from "../../shared/collab/threads";
import { REVISIONS_MAP, type RevisionEntry } from "../../shared/collab/revision-log";
import {
  locateText,
  proposalRedoRequest,
  REVIEW_PROPOSALS_MAP,
  updateProposal,
  type ProposalEntry,
} from "../../shared/collab/review-proposals";
import { getEditorCollab } from "./editor-collab";
import { decideChangeSet } from "./use-change-sets";

type Editor = BlockNoteEditor<any, any, any>;

/**
 * The tracked change that currently answers a proposal: the one placed from
 * the review, or the AI's newer version after the author asked again.
 */
export function proposalChangeSet(entry: ProposalEntry, thread: ThreadSnapshot | undefined): number | undefined {
  if (entry.state === "pending") return entry.changeSetId;
  if (entry.state === "redo") return thread?.meta.changeSet;
  return undefined;
}

function maps(editor: Editor) {
  const collab = getEditorCollab(editor);
  if (!collab) return null;
  return {
    ydoc: collab.ydoc,
    proposals: collab.ydoc.getMap<ProposalEntry>(REVIEW_PROPOSALS_MAP),
    threads: collab.ydoc.getMap(COLLAB_THREADS_MAP) as Y.Map<any>,
  };
}

function settle(editor: Editor, entry: ProposalEntry, patch: Partial<ProposalEntry>, resolveThread = true) {
  const m = maps(editor);
  if (!m) return;
  m.ydoc.transact(() => {
    updateProposal(m.proposals, entry.key, patch);
    const thread = entry.threadId ? readThreads(m.threads).find((item) => item.id === entry.threadId) : undefined;
    if (resolveThread && thread && !thread.resolved) updateThreadMeta(m.threads, thread.id, { status: "resolved", changeSet: undefined });
  });
}

/** The author verified the proposal: it becomes manuscript text. */
export function acceptProposal(editor: Editor, entry: ProposalEntry, changeSetId: number) {
  decideChangeSet(editor, changeSetId, true);
  settle(editor, entry, { state: "accepted", decidedAt: Date.now() });
}

/** The author keeps the original wording. */
export function rejectProposal(editor: Editor, entry: ProposalEntry, changeSetId: number | undefined) {
  if (changeSetId !== undefined) decideChangeSet(editor, changeSetId, false);
  settle(editor, entry, { state: "rejected", decidedAt: Date.now() });
}

/** Leaves a proposal that could not be placed, or an AI answer, without changing the text. */
export function dismissProposal(editor: Editor, entry: ProposalEntry) {
  settle(editor, entry, { state: "dismissed", decidedAt: Date.now() });
}

/** Selects the passage (or the whole paragraph) so the author can type over it. */
export function revealProposal(editor: Editor, entry: Pick<ProposalEntry, "blockId">, text?: string, focus = true) {
  const view = editor.prosemirrorView;
  if (!view || view.isDestroyed) return false;
  let range: { from: number; to: number } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (range) return false;
    if (node.type.name !== "blockContainer" || node.attrs.id !== entry.blockId) return true;
    const content = node.firstChild;
    if (!content) return false;
    range = (text && locateText(content, pos + 2, text)) || { from: pos + 2, to: pos + 1 + content.nodeSize - 1 };
    return false;
  });
  const found = range as { from: number; to: number } | null;
  if (!found) return false;
  try {
    if (focus) {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, found.from, Math.max(found.from, found.to))).scrollIntoView());
      view.focus();
    }
    const { node } = view.domAtPos(found.from);
    (node instanceof Element ? node : node.parentElement)?.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch { return false; }
  return true;
}

/** Accepts the proposal and hands the passage to the author to rewrite in place. */
export function rewriteProposal(editor: Editor, entry: ProposalEntry, changeSetId: number) {
  decideChangeSet(editor, changeSetId, true);
  settle(editor, entry, { state: "editing" }, false);
  // The placed proposal's text is known; the AI's newer version is found by its paragraph.
  requestAnimationFrame(() => revealProposal(editor, entry, entry.state === "pending" ? entry.after : undefined));
}

export function finishRewrite(editor: Editor, entry: ProposalEntry) {
  settle(editor, entry, { state: "edited", decidedAt: Date.now() });
}

/**
 * Rejects the current version and asks ScholarPen AI for another one,
 * following the author's instruction, in a thread tied to the paragraph.
 */
export function redoProposal(editor: Editor, entry: ProposalEntry, changeSetId: number | undefined, previous: string, instruction: string) {
  const m = maps(editor);
  if (!m) return;
  if (changeSetId !== undefined) decideChangeSet(editor, changeSetId, false);
  const unplaced = entry.state === "unplaced";
  const request = proposalRedoRequest(entry, previous, instruction,
    unplaced ? "검토 당시 수정안 (원문이 바뀌어 자동 적용하지 못함)" : undefined);
  const now = Date.now();
  m.ydoc.transact(() => {
    const open = entry.threadId ? readThreads(m.threads).find((thread) => thread.id === entry.threadId && !thread.resolved) : undefined;
    let threadId = open?.id;
    if (threadId) {
      addThreadComment(m.threads, threadId, LOCAL_USER_ID, request);
      updateThreadMeta(m.threads, threadId, { assignee: "ai", manual: false, status: "open", statusNote: undefined, changeSet: undefined, requestedAt: now });
    } else {
      threadId = createThread(m.threads, LOCAL_USER_ID, request, { assignee: "ai", reviewProposal: entry.key, blockId: entry.blockId, requestedAt: now });
    }
    updateProposal(m.proposals, entry.key, { state: "redo", threadId, instruction, redoCount: (entry.redoCount ?? 0) + 1, decidedAt: undefined });
  });
}

/**
 * Keeps proposal states in step with decisions made elsewhere (the review bar,
 * Accept all, the Activity tab): the revision log records each decision.
 */
export function syncProposalStates(ydoc: Y.Doc, entries: ProposalEntry[], threads: ThreadSnapshot[]) {
  const proposals = ydoc.getMap<ProposalEntry>(REVIEW_PROPOSALS_MAP);
  const revisions = ydoc.getMap<RevisionEntry>(REVISIONS_MAP);
  const updates: Array<[string, Partial<ProposalEntry>]> = [];
  for (const entry of entries) {
    if (entry.state === "pending" && entry.revisionId) {
      const status = revisions.get(entry.revisionId)?.status;
      if (status === "accepted" || status === "partial") updates.push([entry.key, { state: "accepted", decidedAt: Date.now() }]);
      else if (status === "rejected") updates.push([entry.key, { state: "rejected", decidedAt: Date.now() }]);
    } else if (entry.state === "redo" && entry.threadId) {
      const thread = threads.find((item) => item.id === entry.threadId);
      if (thread && !thread.resolved && thread.meta.status !== "resolved") continue;
      // Accepting the AI's version in full resolves its thread; its revision log entry says so.
      const latest = [...revisions.values()].filter((revision) => revision?.items?.some((item) => item.threadId === entry.threadId))
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      const accepted = latest?.status === "accepted" || latest?.status === "partial";
      updates.push([entry.key, { state: accepted ? "accepted" : "dismissed", decidedAt: Date.now() }]);
    }
  }
  if (!updates.length) return;
  ydoc.transact(() => { for (const [key, patch] of updates) updateProposal(proposals, key, patch); });
}
