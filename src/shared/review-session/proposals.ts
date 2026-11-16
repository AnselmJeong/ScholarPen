import type { ReviewSession, RoundResult } from "./types";

/**
 * One text revision from a Review & Revision session, shown in the manuscript
 * itself as a tracked change for the author to verify, rewrite or send back.
 * "applied": the review applied it to its own copy; "deferred": the review
 * held it back for the author (unverified numbers, a mismatched baseline …).
 */
export interface ReviewProposal {
  /** `${sessionId}/${id}`; identifies the proposal in every document's Y.Doc. */
  key: string;
  sessionId: string;
  round: number;
  /** Change or author-check id from the session, e.g. C1-p2 or A1-p1. */
  id: string;
  /** Manuscript file under documents/. */
  document: string;
  blockId: string;
  before: string;
  after: string;
  origin: "applied" | "deferred";
  /** Why the review held a deferred proposal back. */
  reason?: string;
  rationale: string;
  /** The reviewer comments this proposal answers. */
  comments: Array<{ id: string; reviewerId: string; text: string }>;
}

export interface StagedProposals {
  schemaVersion: 1;
  sessionId: string;
  round: number;
  stagedAt: string;
  proposals: ReviewProposal[];
}

const TARGET = /^(.+?\.scholarpen\.json)#([^:]+):(.+)$/;

/** Document, block and in-block path of a text slot id; null for figures, captions and tables rows. */
export function parseTextTarget(target: string) {
  const match = TARGET.exec(target);
  if (!match) return null;
  const path = match[3]!;
  // Only inline text lives in the editor's text; props (captions, figure sources) do not.
  if (!/(^|\/)content\//.test(path) || !path.endsWith("/text") || path.includes("/props/")) return null;
  return { document: match[1]!, blockId: match[2]!, path };
}

/** Every text revision of the session's selected round, applied and deferred, in manuscript order. */
export function proposalsFromSession(session: ReviewSession, result: RoundResult): ReviewProposal[] {
  const comments = (ids: string[]) => ids.flatMap(id => {
    const comment = session.comments.find(item => item.id === id);
    return comment ? [{ id, reviewerId: comment.reviewerId, text: comment.original }] : [];
  });
  const proposals: ReviewProposal[] = [];
  const add = (item: { id: string; target: string; before: string; after: string; commentIds: string[]; rationale: string }, origin: ReviewProposal["origin"], reason?: string) => {
    const target = parseTextTarget(item.target);
    if (!target || !session.input.documents.includes(target.document)) return;
    if (!item.before.trim() || item.before === item.after) return;
    proposals.push({
      key: `${session.id}/${item.id}`, sessionId: session.id, round: result.round, id: item.id,
      document: target.document, blockId: target.blockId, before: item.before, after: item.after, origin,
      ...(reason ? { reason } : {}), rationale: item.rationale, comments: comments(item.commentIds),
    });
  };
  for (const change of result.changes) add(change, "applied");
  for (const check of result.authorChecks ?? []) {
    if (check.kind && check.kind !== "text") continue;
    add({ ...check, after: check.proposed }, "deferred", check.reason);
  }
  const order = session.input.documents;
  return proposals.sort((a, b) => order.indexOf(a.document) - order.indexOf(b.document));
}
