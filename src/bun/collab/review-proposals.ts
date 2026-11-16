import { EditorState } from "prosemirror-state";
import type { CollabSession } from "./registry";
import { COLLAB_FRAGMENT } from "../../shared/collab/protocol";
import { CHANGE_SETS_MAP, type ChangeSetInfo } from "../../shared/collab/change-sets";
import { SCHOLARPEN_AI } from "../../shared/collab/personas";
import { nextSuggestionId } from "../../shared/collab/suggested-edits";
import { recordRevision, REVISIONS_MAP, type RevisionEntry } from "../../shared/collab/revision-log";
import {
  buildProposalTransaction,
  locateText,
  proposalLabel,
  REVIEW_PROPOSALS_MAP,
  type ProposalEntry,
} from "../../shared/collab/review-proposals";
import type { ReviewProposal } from "../../shared/review-session/proposals";
import { blockContent, findBlock, readDoc, writeBlock } from "./agent/doc-model";

/** Transaction origin of placed proposals: not an AI edit, so "Undo AI edit" leaves them alone. */
export const REVIEW_PROPOSAL_ORIGIN = "review-proposals";

export interface PlacementResult { placed: number; unplaced: number; waiting: number }

/**
 * Shows a document's Review & Revision proposals in it: each becomes a tracked
 * change of its own (one change set), recorded in the revision log and in the
 * Y.Doc's proposal map. A proposal already in the map is never placed again;
 * one whose passage has another pending change waits for the next call.
 */
export function placeReviewProposals(session: CollabSession, proposals: ReviewProposal[], now = Date.now()): PlacementResult {
  const result: PlacementResult = { placed: 0, unplaced: 0, waiting: 0 };
  // A document still loading would be seeded over.
  if (session.seeding || session.ydoc.getXmlFragment(COLLAB_FRAGMENT).length === 0) return result;
  const entries = session.ydoc.getMap<ProposalEntry>(REVIEW_PROPOSALS_MAP);
  const record = (entry: ProposalEntry) => session.ydoc.transact(() => entries.set(entry.key, entry), REVIEW_PROPOSAL_ORIGIN);
  for (const proposal of proposals) {
    if (proposal.document !== session.filename || entries.has(proposal.key)) continue;
    const doc = readDoc(session);
    const block = findBlock(doc, proposal.blockId);
    if (!block) {
      record({ ...proposal, state: "unplaced", placedAt: now, note: "검토 당시의 문단을 원고에서 찾지 못했습니다. 문단이 삭제되었거나 다른 문서로 옮겨졌을 수 있습니다." });
      result.unplaced++;
      continue;
    }
    const changeSetId = nextSuggestionId(doc);
    const placement = buildProposalTransaction(EditorState.create({ schema: session.schema, doc }), block.pos, proposal.before, proposal.after, changeSetId);
    if (placement.kind === "pending") { result.waiting++; continue; }
    if (placement.kind === "missing") {
      const content = blockContent(block);
      const done = !!locateText(content.node, content.from, proposal.after);
      record({ ...proposal, state: done ? "accepted" : "unplaced", placedAt: now, ...(done ? { decidedAt: now } : {}),
        note: done ? "수정안이 이미 원고에 반영되어 있습니다." : "검토 후 이 문단의 원문이 바뀌어 수정 위치를 자동으로 찾지 못했습니다. 아래 수정안을 참고해 직접 고치거나 AI에게 다시 요청하세요." });
      if (!done) result.unplaced++;
      continue;
    }
    const updated = placement.tr.doc.nodeAt(block.pos);
    if (!updated || updated.attrs.id !== block.id) { result.waiting++; continue; }
    writeBlock(session, updated, REVIEW_PROPOSAL_ORIGIN);
    const label = proposalLabel(proposal);
    session.ydoc.transact(() => {
      session.ydoc.getMap<ChangeSetInfo>(CHANGE_SETS_MAP).set(String(changeSetId), {
        id: changeSetId, label, persona: SCHOLARPEN_AI.id, reviewProposal: proposal.key, createdAt: now,
      });
      const revisionId = recordRevision(session.ydoc.getMap<RevisionEntry>(REVISIONS_MAP), {
        createdAt: now, kind: "peer-review", label, changeSetId, status: "pending",
        summary: `${proposal.origin === "deferred" ? "자동 검토가 보류한 " : ""}심사의견 반영 수정안 ${proposal.id}: ${proposal.rationale}`,
        items: proposal.comments.map(comment => ({
          threadId: `review:${proposal.key}:${comment.id}`, comment: comment.text, commentBy: "author" as const,
          response: proposal.rationale, outcome: "addressed" as const, blockIds: [proposal.blockId],
        })),
        paragraphs: [{ blockId: proposal.blockId, before: proposal.before, after: proposal.after }],
      });
      entries.set(proposal.key, { ...proposal, state: "pending", changeSetId, revisionId, placedAt: now });
    }, REVIEW_PROPOSAL_ORIGIN);
    result.placed++;
  }
  return result;
}
