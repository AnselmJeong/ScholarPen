import type { BlockNoteEditor } from "@blocknote/core";
import type * as Y from "yjs";
import { CHANGE_SETS_MAP, type ChangeSetInfo } from "../../shared/collab/change-sets";
import { buildProposalTransaction, proposalLabel, REVIEW_PROPOSALS_MAP, type ProposalEntry } from "../../shared/collab/review-proposals";
import { nextSuggestionId } from "../../shared/collab/suggested-edits";
import type { ReviewProposal } from "../../shared/review-session/proposals";

/** Browser-only design preview (`?demo`): shows one Review & Revision proposal, as Bun would place it. */
export function isBrowserDemo() {
  return typeof location !== "undefined" && new URLSearchParams(location.search).has("demo")
    && typeof (window as { __electrobunRpcSocketPort?: unknown }).__electrobunRpcSocketPort !== "number";
}

const SAMPLE: Omit<ReviewProposal, "blockId"> = {
  key: "demo/C1-p1", sessionId: "demo", round: 1, id: "C1-p1", document: "introduction.scholarpen.json",
  before: "Earlier meta-analyses pooled tasks with very different demands.",
  after: "Earlier meta-analyses pooled tasks whose working-memory demands differed by up to a factor of three.",
  origin: "applied", rationale: "The reviewer asked for the size of the difference between pooled tasks; the sentence now states it.",
  comments: [{ id: "R1-C03", reviewerId: "R1", text: "Please quantify how different the pooled tasks were. ‘Very different demands’ is too vague to judge the argument." }],
};

export function placeDemoProposal(editor: BlockNoteEditor<any, any, any>, ydoc: Y.Doc) {
  const entries = ydoc.getMap<ProposalEntry>(REVIEW_PROPOSALS_MAP);
  const view = editor.prosemirrorView;
  if (!view || entries.has(SAMPLE.key)) return;
  let blockPos = -1;
  let blockId = "";
  view.state.doc.descendants((node, pos) => {
    if (blockPos >= 0) return false;
    if (node.type.name === "blockContainer" && node.firstChild?.textContent.includes(SAMPLE.before)) { blockPos = pos; blockId = node.attrs.id; }
    return blockPos < 0;
  });
  if (blockPos < 0) return;
  const id = nextSuggestionId(view.state.doc);
  const placement = buildProposalTransaction(view.state, blockPos, SAMPLE.before, SAMPLE.after, id);
  if (placement.kind !== "ready") return;
  view.dispatch(placement.tr);
  ydoc.transact(() => {
    ydoc.getMap<ChangeSetInfo>(CHANGE_SETS_MAP).set(String(id), { id, label: proposalLabel(SAMPLE), persona: "scholarpen-ai", reviewProposal: SAMPLE.key, createdAt: Date.now() });
    entries.set(SAMPLE.key, { ...SAMPLE, blockId, state: "pending", changeSetId: id, placedAt: Date.now(), layout: 2 });
  });
}
