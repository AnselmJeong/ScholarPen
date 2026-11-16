import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { EditorState } from "prosemirror-state";

// The webview's real schema builds the documents; placement then runs on Bun's copy of it.
const dom = new Window();
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const globals = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "DocumentFragment", "MutationObserver", "DOMParser", "getComputedStyle"] as const;
const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom : Reflect.get(dom, key) });
afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.happyDOM.abort();
});

const { getHeadlessEditor } = await import("../../renderer/collab/collab-peer");
const { blocksToYDoc } = await import("@blocknote/core/yjs");
const { applySuggestion } = await import("@handlewithcare/prosemirror-suggest-changes");
const Y = await import("yjs");
const { CollabRegistry } = await import("./registry");
const { CollabAgent } = await import("./agent/agent");
const { readDoc, findBlock, blockContent, writeBlock } = await import("./agent/doc-model");
const { schemaToSpecJSON } = await import("../../shared/collab/schema-spec");
const { COLLAB_THREADS_MAP } = await import("../../shared/collab/protocol");
const { createThread, readThreads } = await import("../../shared/collab/threads");
const { CHANGE_SETS_MAP } = await import("../../shared/collab/change-sets");
const { REVISIONS_MAP } = await import("../../shared/collab/revision-log");
const { REVIEW_PROPOSALS_MAP, proposalRedoRequest } = await import("../../shared/collab/review-proposals");
const { placeReviewProposals } = await import("./review-proposals");
const { proposalsFromSession } = await import("../../shared/review-session/proposals");
const sync = await import("../review/response-sync");

const editor = getHeadlessEditor();
const schemaSpec = schemaToSpecJSON(editor.pmSchema);
const FILE = "04 Crisis.scholarpen.json";

const BLOCKS = [
  { id: "b1", type: "paragraph", content: [
    { type: "text", text: "이 메타분석의 소규모 연구들은 대부분 유의한 효과를 확인하지 못하였다. ", styles: {} },
    { type: "citation", props: { citekey: "brunoni2016", locator: "" } },
    { type: "text", text: " ELECT-TDCS 임상시험에서는 오히려 tDCS가 escitalopram에 비해 열등한 것으로 나타났다.", styles: {} },
  ] },
  { id: "b2", type: "paragraph", content: "3) 불활성이 아닌 sham 자극: sham 자극에서도 실제로 전류가 흐른다." },
];

let registry: InstanceType<typeof CollabRegistry>;
let agent: InstanceType<typeof CollabAgent> | null = null;
afterEach(async () => {
  agent?.dispose();
  agent = null;
  await registry?.dispose();
});

async function open() {
  const seeded = blocksToYDoc(editor, BLOCKS as any, "document-store");
  registry = new CollabRegistry({
    read: async () => ({ state: Y.encodeStateAsUpdate(seeded), meta: { jsonHash: "h", updatedAt: 0 } }),
    write: async () => {},
    jsonHash: async () => "h",
  }, { update: () => {}, awareness: () => {} });
  await registry.open({ projectPath: "/p", filename: FILE, peerId: "editor", schema: schemaSpec });
  return registry.get(`/p::${FILE}`)!;
}

const session = {
  id: "2026-11-16-peer-c3546aca-c13d-4a7d-a96c-708ed778b263",
  input: { documents: [FILE, "09 Conclusion.scholarpen.json"], language: "Korean" },
  comments: [
    { id: "R1-C02", reviewerId: "R1", original: "ELECT-TDCS 표현을 서론과 일치시켜 주십시오.", targets: [], severity: "major", source: "human" },
    { id: "R1-C05", reviewerId: "R1", original: "소제목을 ‘생리적 불활성을 보장하기 어려운 sham 자극’으로 조정해 주십시오.", targets: [], severity: "major", source: "human" },
    { id: "ED-C01", reviewerId: "ED", original: "수정후 게재가", targets: [], severity: "major", source: "human" },
  ],
} as any;
const result = {
  round: 1,
  changes: [
    { id: "C1-p2", target: `${FILE}#b1:0/content/2/text`, before: " ELECT-TDCS 임상시험에서는 오히려 tDCS가 escitalopram에 비해 열등한 것으로 나타났다.",
      after: " ELECT-TDCS 임상시험에서 tDCS는 위약보다는 우수했으나, escitalopram에 대한 비열등성을 입증하지 못하였다.", commentIds: ["R1-C02"], rationale: "서론과 일치시켰다." },
    { id: "C1-figure-x", target: `${FILE}#fig`, before: "a.png", after: "b.png", commentIds: ["R1-C02"], rationale: "figure" },
  ],
  authorChecks: [
    { id: "A1-p6", target: `${FILE}#b2:1/content/0/text`, before: "3) 불활성이 아닌 sham 자극: sham 자극에서도 실제로 전류가 흐른다.",
      proposed: "3) 생리적 불활성을 보장하기 어려운 sham 자극: sham 자극에서도 실제로 전류가 흐른다.", commentIds: ["R1-C05"], rationale: "소제목 조정", reason: "Patch baseline mismatch" },
    { kind: "response", id: "RESPONSE1-ED-C01", target: "ED-C01", before: "", proposed: "감사합니다", commentIds: ["ED-C01"], rationale: "", reason: "" },
    { id: "A1-cap", target: `${FILE}#fig:2/props/caption`, before: "Old", proposed: "New", commentIds: ["R1-C05"], rationale: "", reason: "" },
  ],
} as any;

function marks(target: any, blockId: string) {
  const out: Array<{ text: string; mark: string }> = [];
  blockContent(findBlock(readDoc(target), blockId)!).node.descendants((node) => {
    if (node.isText) out.push({ text: node.text!, mark: node.marks.map((m) => m.type.name).join(",") });
    else if (node.isInline) out.push({ text: `[${node.type.name}]`, mark: "" });
  });
  return out;
}

function accept(target: any, changeSetId: number) {
  const state = EditorState.create({ schema: target.schema, doc: readDoc(target) });
  applySuggestion(changeSetId)(state, (tr) => {
    for (const id of ["b1", "b2"]) {
      const block = findBlock(tr.doc, id)!;
      writeBlock(target, block.node, "editor");
    }
  });
}

test("a session yields its text revisions, applied and held back, and nothing else", () => {
  const proposals = proposalsFromSession(session, result);
  expect(proposals.map((p) => [p.id, p.origin, p.blockId])).toEqual([["C1-p2", "applied", "b1"], ["A1-p6", "deferred", "b2"]]);
  expect(proposals[1].reason).toBe("Patch baseline mismatch");
  expect(proposals[0].comments[0]).toMatchObject({ id: "R1-C02", reviewerId: "R1" });
  expect(proposals[0].key).toBe(`${session.id}/C1-p2`);
});

test("proposals become tracked changes of their own, recorded once, without touching citations", async () => {
  const target = await open();
  const proposals = proposalsFromSession(session, result);
  expect(placeReviewProposals(target, proposals, 1000)).toEqual({ placed: 2, unplaced: 0, waiting: 0 });

  const b1 = marks(target, "b1");
  expect(b1.find((part) => part.text === "[citation]")).toBeTruthy();
  expect(b1.filter((part) => part.mark.includes("deletion")).map((part) => part.text).join("")).toContain("열등한");
  expect(b1.filter((part) => part.mark.includes("insertion")).map((part) => part.text).join("")).toContain("비열등성을 입증하지 못하였");
  // Untouched text keeps no suggestion mark.
  expect(b1[0]).toEqual({ text: (BLOCKS[0].content as Array<{ text?: string }>)[0].text!, mark: "" });

  const entries = target.ydoc.getMap<any>(REVIEW_PROPOSALS_MAP);
  const placed = entries.get(proposals[0].key);
  expect(placed.state).toBe("pending");
  const other = entries.get(proposals[1].key);
  expect(other.changeSetId).not.toBe(placed.changeSetId);
  expect(target.ydoc.getMap<any>(CHANGE_SETS_MAP).get(String(placed.changeSetId))).toMatchObject({ reviewProposal: proposals[0].key });
  expect(target.ydoc.getMap<any>(REVISIONS_MAP).get(placed.revisionId)).toMatchObject({ kind: "peer-review", status: "pending", changeSetId: placed.changeSetId });

  const before = readDoc(target).toJSON();
  expect(placeReviewProposals(target, proposals, 2000)).toEqual({ placed: 0, unplaced: 0, waiting: 0 });
  expect(readDoc(target).toJSON()).toEqual(before);
});

test("a rewritten passage is left as a card; one already applied counts as accepted", async () => {
  const target = await open();
  const [first, second] = proposalsFromSession(session, result);
  const changed = { ...first, key: "s/changed", before: "이미 사라진 문장." };
  const done = { ...second, key: "s/done", before: "없는 원문", after: "3) 불활성이 아닌 sham 자극:" };
  expect(placeReviewProposals(target, [changed, done])).toEqual({ placed: 0, unplaced: 1, waiting: 0 });
  const entries = target.ydoc.getMap<any>(REVIEW_PROPOSALS_MAP);
  expect(entries.get("s/changed").state).toBe("unplaced");
  expect(entries.get("s/done").state).toBe("accepted");
});

test("asking for another version sends the paragraph to the AI without a comment highlight", async () => {
  const target = await open();
  const [proposal] = proposalsFromSession(session, result);
  let prompt = "";
  agent = new CollabAgent(registry, {
    complete: async (messages) => {
      prompt = messages.map((message) => String(message.content)).join("\n");
      const segments = JSON.parse((messages[1].content as string).match(/<editable_segments>\n([\s\S]*?)\n<\/editable_segments>/)![1]);
      return JSON.stringify({ reply: "다시 썼습니다.", edits: segments.map((segment: any) => ({ id: segment.id,
        text: segment.text.replace("오히려 tDCS가 escitalopram에 비해 열등한 것으로 나타났다", "tDCS의 escitalopram 대비 비열등성은 입증되지 않았다") })) });
    },
    onActivity: () => {}, pollMs: 10, waitForAuthorMs: 50,
  });
  const threads = target.ydoc.getMap(COLLAB_THREADS_MAP);
  let threadId = "";
  target.ydoc.transact(() => {
    threadId = createThread(threads, "me", proposalRedoRequest(proposal, proposal.after, "더 짧게"), { assignee: "ai", reviewProposal: proposal.key, blockId: "b1", requestedAt: 1 });
  }, "editor");
  for (let i = 0; i < 300 && readThreads(threads).find((t) => t.id === threadId)?.meta.changeSet === undefined; i++) await new Promise((r) => setTimeout(r, 10));
  const thread = readThreads(threads).find((t) => t.id === threadId)!;
  expect(thread.meta.changeSet).toBeDefined();
  expect(prompt).toContain("더 짧게");
  expect(prompt).toContain("R1-C02");
  expect(marks(target, "b1").filter((part) => part.mark.includes("insertion")).map((part) => part.text).join("")).toContain("비열등성은 입증되지 않았");
  // No comment mark was added to the manuscript.
  expect(marks(target, "b1").some((part) => part.mark.includes("comment"))).toBe(false);
});

test("decisions in the manuscript rewrite the responses, never leaking internal notes", async () => {
  const target = await open();
  const proposals = proposalsFromSession(session, result);
  placeReviewProposals(target, proposals);
  const entries = target.ydoc.getMap<any>(REVIEW_PROPOSALS_MAP);
  const staged = { schemaVersion: 1 as const, sessionId: session.id, round: 1, stagedAt: "", proposals };
  const sources = { openSession: async () => target, storedState: async () => null, documentJSON: async () => null };

  let decisions = await sync.proposalDecisions(sources, "/p", staged);
  expect(sync.commentSyncStates(session.comments, decisions).map((s) => [s.commentId, s.ready, s.waiting]))
    .toEqual([["R1-C02", false, 1], ["R1-C05", false, 1], ["ED-C01", false, 0]]);

  const first = entries.get(proposals[0].key);
  accept(target, first.changeSetId);
  target.ydoc.transact(() => {
    entries.set(first.key, { ...first, state: "accepted" });
    entries.set(proposals[1].key, { ...entries.get(proposals[1].key), state: "rejected" });
  });
  // A rejected proposal still pending in the text is left out of the final wording.
  decisions = await sync.proposalDecisions(sources, "/p", staged);
  expect(decisions[0].final).toContain("비열등성을 입증하지 못하였");
  expect(decisions[1].final).toBe(BLOCKS[1].content as string);
  const states = sync.commentSyncStates(session.comments, decisions);
  expect(states.every((s) => s.ready)).toBe(true);

  const prompts: string[] = [];
  const { responses } = await sync.rewriteResponses(session, session.comments, [], decisions, {
    complete: async (_system, prompt) => {
      prompts.push(prompt);
      return JSON.stringify({ responses: [
        { commentId: "R1-C02", response: "지적에 따라 서론과 같이 수정하였습니다.\n\n> ELECT-TDCS 임상시험에서 tDCS는 위약보다는 우수했으나" },
        { commentId: "R1-C05", response: "C1-p6 변경은 저자 확인 필요" },
        { commentId: "ED-C01", response: "감사합니다." },
      ] });
    },
  });
  expect(prompts[0]).toContain("rejected; the original wording was kept");
  expect(prompts[0]).toContain("비열등성을 입증하지 못하였");
  expect(responses.get("R1-C02")).toMatchObject({ method: "model" });
  expect(responses.get("ED-C01")).toMatchObject({ method: "model" });
  // Internal ids or review-tool notes never reach the letter.
  expect(responses.get("R1-C05")!.method).toBe("template");
  expect(responses.get("R1-C05")!.response).not.toMatch(sync.INTERNAL_TEXT);
  expect(responses.get("R1-C05")!.response).toContain("원래 서술을 유지");

  const items = session.comments.map((c: any) => ({ commentId: c.id, disposition: "needs-author", response: "저자 확인 필요", changeIds: [], locations: [], verification: "not-verified" }));
  sync.applyRewrittenResponses(items, session.comments, responses, decisions);
  expect(items.map((i: any) => [i.commentId, i.disposition, i.verification])).toEqual([
    ["R1-C02", "changed", "verified"], ["R1-C05", "clarified-no-change", "verified"], ["ED-C01", "clarified-no-change", "verified"]]);
  expect(items[0].changeIds).toEqual(["C1-p2"]);
});

test("decisions of a closed document come from its saved state and manuscript JSON", async () => {
  const target = await open();
  const proposals = proposalsFromSession(session, result);
  placeReviewProposals(target, proposals);
  const entries = target.ydoc.getMap<any>(REVIEW_PROPOSALS_MAP);
  target.ydoc.transact(() => entries.set(proposals[0].key, { ...entries.get(proposals[0].key), state: "edited" }));
  const state = Y.encodeStateAsUpdate(target.ydoc);
  const json = [{ id: "b1", content: [{ type: "text", text: "작가가 고쳐 쓴 문장 " }, { type: "citation", props: { citekey: "x" } }] }];
  const decisions = await sync.proposalDecisions({ openSession: async () => null, storedState: async () => state, documentJSON: async () => json },
    "/p", { schemaVersion: 1, sessionId: session.id, round: 1, stagedAt: "", proposals });
  expect(decisions.map((d) => [d.state, d.final])).toEqual([["edited", "작가가 고쳐 쓴 문장 [@x]"], ["pending", null]]);
});
