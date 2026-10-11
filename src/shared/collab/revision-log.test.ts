import { expect, test } from "bun:test";
import * as Y from "yjs";
import { buildResponseLetter, readRevisions, recordRevision, REVISIONS_MAP, settleRevision, type RevisionEntry } from "./revision-log";

function log() {
  const map = new Y.Doc().getMap<RevisionEntry>(REVISIONS_MAP);
  const add = (createdAt: number, changeSetId: number, items: RevisionEntry["items"]) => recordRevision(map, {
    createdAt, kind: "coordinated", label: "Coordinated", changeSetId, status: "pending", summary: "Plan",
    items, paragraphs: [{ blockId: "p1", before: "Old claim.", after: "New, qualified claim." }],
    references: [{ citekey: "kim2021", title: "Cohort study", doi: "10.1/x" }],
  });
  return { map, add };
}

test("settling a change set updates its pending entry once", () => {
  const { map, add } = log();
  add(1, 7, []);
  settleRevision(map, "7", "accepted", 10);
  settleRevision(map, 7, "rejected", 11);
  expect(readRevisions(map)[0]).toMatchObject({ status: "accepted", decidedAt: 10 });
});

test("the response letter answers accepted comments, lists open questions and leaves out rejected work", () => {
  const { map, add } = log();
  add(1, 1, [
    { threadId: "t1", comment: "The causal claim is too strong.", commentBy: "ai", response: "Qualified the claim.", outcome: "addressed", blockIds: ["p1"] },
    { threadId: "t2", comment: "Which endpoint?", commentBy: "author", response: "Which endpoint do you mean?", outcome: "needs-user", blockIds: [] },
  ]);
  add(2, 2, [{ threadId: "t3", comment: "Rejected idea.", commentBy: "author", response: "Rewrote it.", outcome: "addressed", blockIds: ["p1"] }]);
  settleRevision(map, 1, "accepted", 5);
  settleRevision(map, 2, "rejected", 6);
  const letter = buildResponseLetter(readRevisions(map), "paper.scholarpen.json");
  expect(letter).toMatchObject({ addressed: 1, open: 1 });
  expect(letter.markdown).toContain("# Response to reviewers: paper");
  expect(letter.markdown).toContain("> The causal claim is too strong.\n\n**Response.** Qualified the claim.");
  expect(letter.markdown).toContain("> New, qualified claim.");
  expect(letter.markdown).toContain("*Open question:* Which endpoint do you mean?");
  expect(letter.markdown).not.toContain("Rejected idea");
  expect(buildResponseLetter(readRevisions(map), "paper", { includePending: true }).addressed).toBe(1);
});

test("pending work is only included on request", () => {
  const { map, add } = log();
  add(1, 1, [{ threadId: "t1", comment: "c", commentBy: "ai", response: "r", outcome: "addressed", blockIds: ["p1"] }]);
  expect(buildResponseLetter(readRevisions(map), "d").addressed).toBe(0);
  expect(buildResponseLetter(readRevisions(map), "d", { includePending: true }).markdown).toContain("Proposed, awaiting the author's decision");
});
