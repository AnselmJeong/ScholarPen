import type * as Y from "yjs";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import { transformToSuggestionTransaction } from "@handlewithcare/prosemirror-suggest-changes";
import type { ReviewProposal } from "../review-session/proposals";
import { readableHunks } from "./suggested-edits";

/**
 * Review & Revision proposals placed in a document, keyed by proposal key.
 * Lives in the shared Y.Doc next to the comments, so every peer sees the same
 * state and a proposal is placed only once.
 */
export const REVIEW_PROPOSALS_MAP = "reviewProposals";

/**
 * pending: a tracked change waits for the author.
 * editing: the author accepted it and is rewriting the passage by hand.
 * redo: the author rejected it and asked the AI for another version (threadId).
 * unplaced: the passage changed since the review; only the card is shown.
 */
export type ProposalState = "pending" | "accepted" | "rejected" | "editing" | "edited" | "redo" | "unplaced" | "dismissed";

export interface ProposalEntry extends ReviewProposal {
  state: ProposalState;
  /** Suggestion id of the tracked change placed for this proposal. */
  changeSetId?: number;
  /** Revision-log entry recording what became of it. */
  revisionId?: string;
  placedAt: number;
  decidedAt?: number;
  /** Why the proposal could not be placed, or how it was settled. */
  note?: string;
  /** Comment thread asking the AI for another version. */
  threadId?: string;
  instruction?: string;
  redoCount?: number;
}

/** States that still need the author; settled proposals leave the manuscript. */
export const OPEN_PROPOSAL_STATES: ReadonlySet<ProposalState> = new Set(["pending", "editing", "redo", "unplaced"]);

export function readProposalEntries(map: Y.Map<ProposalEntry>): ProposalEntry[] {
  return [...map.values()].filter((entry): entry is ProposalEntry =>
    !!entry && typeof entry === "object" && typeof entry.key === "string" && typeof entry.blockId === "string");
}

export function updateProposal(map: Y.Map<ProposalEntry>, key: string, patch: Partial<ProposalEntry>) {
  const entry = map.get(key);
  if (entry) map.set(key, { ...entry, ...patch });
}

const SUGGESTION_MARKS = ["insertion", "deletion", "modification"];

/**
 * Where `text` occurs in a node's text, as a document range. Text is matched
 * within runs of adjacent text nodes (marks may differ; atoms such as
 * citations and paragraph boundaries break a run). The first occurrence wins.
 */
export function locateText(node: PMNode, offset: number, text: string): { from: number; to: number } | null {
  if (!text) return null;
  const runs: Array<{ from: number; text: string }> = [];
  node.descendants((child, pos) => {
    if (!child.isText) return true;
    const at = offset + pos;
    const last = runs.at(-1);
    if (last && last.from + last.text.length === at) last.text += child.text ?? "";
    else runs.push({ from: at, text: child.text ?? "" });
    return false;
  });
  for (const run of runs) {
    const index = run.text.indexOf(text);
    if (index >= 0) return { from: run.from + index, to: run.from + index + text.length };
  }
  return null;
}

function hasSuggestionBetween(doc: PMNode, from: number, to: number) {
  let found = false;
  doc.nodesBetween(from, to, (node) => {
    if (found) return false;
    if (node.marks.some((mark) => SUGGESTION_MARKS.includes(mark.type.name))) found = true;
    return !found;
  });
  return found;
}

export type ProposalPlacement =
  | { kind: "ready"; tr: Transaction; from: number; to: number }
  /** The original wording is not in the paragraph any more. */
  | { kind: "missing" }
  /** Another pending change overlaps the passage; try again once it is settled. */
  | { kind: "pending" };

/**
 * The tracked change that turns `before` into `after` inside the block at
 * `blockPos`, word by word, carrying suggestion id `changeSetId`.
 */
export function buildProposalTransaction(state: EditorState, blockPos: number, before: string, after: string, changeSetId: number): ProposalPlacement {
  const block = state.doc.nodeAt(blockPos);
  const content = block?.firstChild;
  if (!block || !content) return { kind: "missing" };
  const range = locateText(content, blockPos + 2, before);
  if (!range) return hasSuggestionBetween(state.doc, blockPos, blockPos + block.nodeSize) ? { kind: "pending" } : { kind: "missing" };
  if (hasSuggestionBetween(state.doc, range.from, range.to)) return { kind: "pending" };
  let tr = state.tr;
  const hunks = readableHunks(before, after);
  for (const hunk of [...hunks].reverse()) {
    const from = range.from + hunk.from;
    const to = range.from + hunk.to;
    const $from = tr.doc.resolve(from);
    const marks = from === to ? $from.marks() : $from.marksAcross(tr.doc.resolve(to)) ?? $from.marks();
    if (hunk.insert) tr.replaceWith(from, to, state.schema.text(hunk.insert, marks));
    else tr.delete(from, to);
  }
  if (!tr.docChanged) return { kind: "missing" };
  tr = transformToSuggestionTransaction(tr, state, () => changeSetId);
  return { kind: "ready", tr, from: range.from, to: tr.mapping.map(range.to, 1) };
}

function clip(text: string, max: number) {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Short label for the change set and its cards, e.g. "R1-C02 · 심사 반영". */
export function proposalLabel(proposal: Pick<ReviewProposal, "comments" | "id">) {
  const ids = proposal.comments.map((comment) => comment.id);
  return `${ids.length ? ids.join(", ") : proposal.id} · 심사 반영`;
}

/** What the AI is asked when the author rejects a proposal and wants another version. */
export function proposalRedoRequest(proposal: Pick<ReviewProposal, "id" | "comments" | "rationale">, rejected: string, instruction: string,
  previousLabel = "저자가 거절한 수정안") {
  const comments = proposal.comments.map((comment) => `${comment.reviewerId} · ${comment.id}\n${clip(comment.text, 1500)}`).join("\n\n");
  return [
    `[심사 반영 수정안 다시 작성 · ${proposal.id}]`,
    comments ? `심사의견\n${comments}` : "",
    rejected.trim() ? `${previousLabel}\n${clip(rejected, 2000)}` : "",
    `저자 지시\n${instruction.trim() || "거절한 수정안과 다른 방식으로 심사의견을 반영해 주세요."}`,
    "이 문단만 고쳐 주세요. 심사의견과 저자 지시가 요구하지 않는 내용, 인용과 수치는 바꾸지 마세요.",
  ].filter(Boolean).join("\n\n");
}
