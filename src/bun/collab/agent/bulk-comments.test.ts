import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { OllamaMessage } from "../../../shared/rpc-types";
import type { CollabSession } from "../registry";

const dom = new Window();
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const globals = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "DocumentFragment", "MutationObserver", "DOMParser", "getComputedStyle"] as const;
const previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom : Reflect.get(dom, key) });
afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.happyDOM.abort();
});
const { getHeadlessEditor } = await import("../../../renderer/collab/collab-peer");
const { blocksToYDoc } = await import("@blocknote/core/yjs");
const Y = await import("yjs");
const { CollabRegistry } = await import("../registry");
const { CollabAgent } = await import("./agent");
const { schemaToSpecJSON } = await import("../../../shared/collab/schema-spec");
const { readDoc, findBlock, blockContent, writeBlock, anchorThread } = await import("./doc-model");
const { COLLAB_THREADS_MAP } = await import("../../../shared/collab/protocol");
const { CHANGE_SETS_MAP } = await import("../../../shared/collab/change-sets");
const { createThread, readThreads, updateThreadMeta, addThreadComment, AI_USER_ID } = await import("../../../shared/collab/threads");
const { requestBulkComments, resolveAllComments } = await import("../../../shared/collab/bulk-comments");
const { listChangeSets } = await import("../../../renderer/collab/suggestions");
const { EditorState } = await import("prosemirror-state");
const editor = getHeadlessEditor();
let registry: InstanceType<typeof CollabRegistry>;
let agent: InstanceType<typeof CollabAgent>;
afterEach(async () => { agent?.dispose(); await registry?.dispose(); });

interface Payload {
  manuscript: Array<{ id: string; text: string }>;
  candidateManuscript?: Array<{ id: string; text: string }>;
  editable_segments: Array<{ id: string; blockId: string; text: string }>;
  comments: Array<{ id: string; target: boolean; comments: Array<{ text: string }> }>;
  unlinkedParagraphIds?: string[];
  proposedOutcomes?: Array<{ threadId: string; status: string; reason: string; blockIds: string[] }>;
}
const payloadOf = (messages: OllamaMessage[]) => JSON.parse(String(messages[1].content)) as Payload;
function answer(messages: OllamaMessage[]) {
  const payload = payloadOf(messages);
  if (payload.candidateManuscript) return JSON.stringify({ consistent: true, outcomes: payload.proposedOutcomes });
  return JSON.stringify({ summary: "Use the same qualified claim throughout.",
    edits: payload.editable_segments.filter(segment => segment.text.includes("prove")).map(segment => ({ id: segment.id, text: segment.text.replace("prove", "suggest") })),
    outcomes: payload.comments.filter(comment => comment.target).map(comment => ({ threadId: comment.id,
      status: comment.comments[0].text.includes("Decide") ? "needs-user" : "addressed",
      reason: comment.comments[0].text.includes("Decide") ? "Which primary endpoint do you intend?" : "Qualified the introduction and conclusion together.",
      blockIds: comment.comments[0].text.includes("Decide") ? [] : ["p1", "p2"],
    })),
  });
}
async function setup(respond: (messages: OllamaMessage[]) => Promise<string> = async messages => answer(messages), extra = 0) {
  const blocks = [
    { id: "p1", type: "paragraph" as const, content: "These findings prove the hypothesis." },
    ...Array.from({ length: extra }, (_, index) => ({ id: `middle-${index}`, type: "paragraph" as const, content: `Middle paragraph ${index}.` })),
    { id: "p2", type: "paragraph" as const, content: "Our conclusions prove the hypothesis." },
  ];
  const seeded = blocksToYDoc(editor, blocks, "document-store");
  registry = new CollabRegistry({ read: async () => ({ state: Y.encodeStateAsUpdate(seeded), meta: null }), write: async () => {}, jsonHash: async () => "h" }, { update: () => {}, awareness: () => {} });
  seeded.destroy();
  await registry.open({ projectPath: "/p", filename: "doc.scholarpen.json", peerId: "editor", schema: schemaToSpecJSON(editor.pmSchema) });
  const session = registry.get("/p::doc.scholarpen.json")!;
  const calls: OllamaMessage[][] = [];
  agent = new CollabAgent(registry, { complete: async messages => { calls.push(messages); return respond(messages); }, onActivity: () => {}, pollMs: 1 });
  const map = session.ydoc.getMap(COLLAB_THREADS_MAP);
  const ai = createThread(map, AI_USER_ID, "Qualify the causal inference.", { assignee: "me", blockId: "p1" });
  const human = createThread(map, "me", "Keep the conclusion consistent with the introduction.", { manual: true, blockId: "p2" });
  const decision = createThread(map, "me", "Decide which endpoint to use.", { manual: true, blockId: "p1" });
  anchorThread(session, "p1", ai, "editor");
  anchorThread(session, "p2", human, "editor");
  const old = createThread(map, "me", "Retain the author's historical interpretation.", { manual: true, status: "open" });
  updateThreadMeta(map, old, { status: "resolved" });
  return { session, calls, ai, human, decision, old };
}
async function done(session: CollabSession) {
  agent.rescan(session.docKey);
  for (let i = 0; i < 300 && agent.isBusy(session.docKey); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(agent.isBusy(session.docKey)).toBe(false);
}
const threadsOf = (session: CollabSession) => readThreads(session.ydoc.getMap(COLLAB_THREADS_MAP));

test("AI and author comments become one verified suggestion, with decisions left open and no 60-paragraph cutoff", async () => {
  const { session, calls, ai, human, decision, old } = await setup(undefined, 65);
  const request = requestBulkComments(session.ydoc, "Preserve my thesis.");
  await done(session);
  expect(agent.jobs(session.docKey)[0].state).toBe("done");
  expect(calls).toHaveLength(2);
  expect(payloadOf(calls[0]).manuscript).toHaveLength(67);
  // Resolved comments are settled; they are not sent at all.
  expect(payloadOf(calls[0]).comments.some(comment => comment.comments[0].text.includes("historical"))).toBe(false);
  expect(payloadOf(calls[1]).candidateManuscript!.at(-1)!.text).toContain("suggest");
  const sets = listChangeSets(readDoc(session), session.ydoc.getMap(CHANGE_SETS_MAP));
  expect(sets).toHaveLength(1);
  expect(sets[0].paragraphs.map(paragraph => paragraph.blockId)).toEqual(["p1", "p2"]);
  expect(sets[0].info?.addressedThreadIds).toEqual([ai, human]);
  expect(sets[0].info?.threadId).toBe(request);
  expect(threadsOf(session).find(thread => thread.id === decision)?.meta.status).toBe("open");
  expect(threadsOf(session).find(thread => thread.id === ai)?.meta.status).toBe("proposed");
  expect(threadsOf(session).every(thread => !thread.meta.bulkRequestId)).toBe(true);
  expect(agent.undoLast(session.docKey)).toBe(true);
  expect(readDoc(session).textContent).not.toContain("suggest");
  expect(agent.canUndo(session.docKey)).toBe(false); // One atomic edit, not one undo per paragraph.
});

test("a failed consistency check leaves the entire manuscript untouched", async () => {
  const { session } = await setup(async messages => payloadOf(messages).candidateManuscript
    ? JSON.stringify({ consistent: false, outcomes: [] }) : answer(messages));
  const before = readDoc(session).toJSON();
  requestBulkComments(session.ydoc);
  await done(session);
  expect(agent.jobs(session.docKey)[0].state).toBe("failed");
  expect(readDoc(session).toJSON()).toEqual(before);
  expect(threadsOf(session).every(thread => !thread.meta.bulkRequestId)).toBe(true);
  expect(session.ydoc.getMap(CHANGE_SETS_MAP).size).toBe(0);
});

test("all-needs-user result explains decisions without changing text or closing the claims", async () => {
  const { session, calls, ai, human, decision } = await setup(async messages => JSON.stringify({ summary: "Author input needed.", edits: [],
    outcomes: payloadOf(messages).comments.filter(comment => comment.target).map(comment => ({ threadId: comment.id, status: "needs-user", reason: "Supply the evidence first.", blockIds: ["p1"] })),
  }));
  const before = readDoc(session).toJSON();
  requestBulkComments(session.ydoc);
  await done(session);
  expect(calls).toHaveLength(1);
  expect(readDoc(session).toJSON()).toEqual(before);
  for (const id of [ai, human, decision]) expect(threadsOf(session).find(thread => thread.id === id)?.resolved).toBe(false);
});

for (const mutation of ["text", "comment", "resolve-all"] as const) {
  test(`${mutation} during verification discards the entire stale proposal`, async () => {
    let change = () => {};
    const { session } = await setup(async messages => {
      if (payloadOf(messages).candidateManuscript) change();
      return answer(messages);
    });
    change = () => {
      if (mutation === "resolve-all") resolveAllComments(session.ydoc);
      else if (mutation === "comment") createThread(session.ydoc.getMap(COLLAB_THREADS_MAP), "me", "New constraint.", { manual: true });
      else {
        const doc = readDoc(session), block = findBlock(doc, "p2")!;
        const state = EditorState.create({ schema: session.schema, doc });
        writeBlock(session, state.tr.insertText(" Author change.", blockContent(block).to).doc.nodeAt(block.pos)!, "editor");
      }
    };
    requestBulkComments(session.ydoc);
    await done(session);
    expect(readDoc(session).textContent).not.toContain("suggest");
    expect(session.ydoc.getMap(CHANGE_SETS_MAP).size).toBe(0);
    expect(threadsOf(session).every(thread => !thread.meta.bulkRequestId)).toBe(true);
    if (mutation === "resolve-all") expect(threadsOf(session).every(thread => thread.resolved)).toBe(true);
  });
}

for (const malformed of ["omitted-outcome", "unknown-segment", "empty-segment", "decision-upgrade"] as const) {
  test(`${malformed} fails closed without partial edits`, async () => {
    const { session } = await setup(async messages => {
      const data = JSON.parse(answer(messages));
      if (!payloadOf(messages).candidateManuscript) {
        if (malformed === "omitted-outcome") data.outcomes.pop();
        if (malformed === "unknown-segment") data.edits[0].id = "unknown";
        if (malformed === "empty-segment") data.edits[0].text = "";
      } else if (malformed === "decision-upgrade") {
        data.outcomes.at(-1).status = "addressed";
        data.outcomes.at(-1).blockIds = ["p1"];
      }
      return JSON.stringify(data);
    });
    const before = readDoc(session).toJSON();
    requestBulkComments(session.ydoc);
    await done(session);
    expect(agent.jobs(session.docKey)[0].state).toBe("failed");
    expect(readDoc(session).toJSON()).toEqual(before);
  });
}

test("Resolve all closes both authors' comments without altering the manuscript", async () => {
  const { session } = await setup();
  const before = readDoc(session).toJSON();
  expect(resolveAllComments(session.ydoc)).toBe(3);
  expect(threadsOf(session).every(thread => thread.resolved)).toBe(true);
  expect(readDoc(session).toJSON()).toEqual(before);
});

test("an interrupted bulk request releases all participant comments after restart", async () => {
  const { session } = await setup();
  agent.setPaused(true);
  const request = requestBulkComments(session.ydoc);
  updateThreadMeta(session.ydoc.getMap(COLLAB_THREADS_MAP), request, { status: "in-progress" });
  agent.dispose();
  agent = new CollabAgent(registry, { complete: async () => { throw new Error("Must not restart automatically"); }, onActivity: () => {} });
  expect(threadsOf(session).every(thread => !thread.meta.bulkRequestId)).toBe(true);
  expect(threadsOf(session).find(thread => thread.id === request)?.meta.status).toBe("open");
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(agent.jobs(session.docKey)).toHaveLength(0);
});

test("a second bulk request cannot stack over pending suggestions", async () => {
  const { session } = await setup();
  requestBulkComments(session.ydoc);
  await done(session);
  const before = readDoc(session).toJSON();
  requestBulkComments(session.ydoc);
  await done(session);
  expect(agent.jobs(session.docKey)[0].state).toBe("failed");
  expect(agent.jobs(session.docKey)[0].detail).toContain("pending edits");
  expect(readDoc(session).toJSON()).toEqual(before);
  expect(listChangeSets(readDoc(session))).toHaveLength(1);
});

test("eighty comments are all included and accounted for in both passes", async () => {
  const { session, calls } = await setup();
  const map = session.ydoc.getMap(COLLAB_THREADS_MAP);
  for (let i = 0; i < 77; i++) createThread(map, AI_USER_ID, `Review concern ${i}.`, { assignee: "me", blockId: "p1" });
  requestBulkComments(session.ydoc);
  await done(session);
  expect(agent.jobs(session.docKey)[0].state).toBe("done");
  expect(payloadOf(calls[0]).comments.filter(comment => comment.target)).toHaveLength(80);
  expect(payloadOf(calls[1]).proposedOutcomes).toHaveLength(80);
  expect(threadsOf(session).filter(thread => thread.meta.status === "proposed" && !thread.meta.documentAction)).toHaveLength(79);
});

test("short stable references, harmless duplicate outcomes and deferred field variants are normalized", async () => {
  const { session, calls, old } = await setup(async messages => {
    const payload = payloadOf(messages);
    const data = JSON.parse(answer(messages));
    expect(payload.manuscript[0].id).toBe("P1");
    expect(payload.comments[0].id).toBe("C1");
    if (!payload.candidateManuscript) {
      data.outcomes[0].blockIds = ["b0s0", "b1s0"]; // Exact segment-to-paragraph mapping, never fuzzy matching.
      data.outcomes[1].blockIds = ["P1", "P2"];
      data.outcomes[2].status = " NEEDS_USER ";
      delete data.outcomes[2].blockIds;
      data.outcomes.push({ ...data.outcomes[0] });
    }
    return JSON.stringify(data);
  });
  requestBulkComments(session.ydoc);
  await done(session);
  expect(agent.jobs(session.docKey)[0].state).toBe("done");
  expect(calls).toHaveLength(2);
  expect(threadsOf(session).find(thread => thread.id === old)?.comments).toHaveLength(1);
});

for (const stage of ["revision", "verification"] as const) {
  test(`automatically repairs ${stage} metadata once without changing proposed prose`, async () => {
    let corrupted = false;
    const { session, calls } = await setup(async messages => {
      const payload = payloadOf(messages);
      const data = JSON.parse(answer(messages));
      const repair = String(messages[0].content).includes("Repair only");
      if (repair) {
        expect(String(messages[1].content)).toContain("unknown comment ID");
        return JSON.stringify({ outcomes: stage === "revision" ? data.outcomes : payload.proposedOutcomes });
      }
      if (!corrupted && !!payload.candidateManuscript === (stage === "verification")) {
        corrupted = true;
        data.outcomes[0].threadId = "C999";
      }
      return JSON.stringify(data);
    });
    requestBulkComments(session.ydoc);
    await done(session);
    expect(agent.jobs(session.docKey)[0].state).toBe("done");
    expect(calls).toHaveLength(3);
    expect(listChangeSets(readDoc(session))).toHaveLength(1);
  });
}

test("persistent conflicting duplicate outcomes stop after one repair with a precise explanation", async () => {
  const { session, calls } = await setup(async messages => {
    const data = JSON.parse(answer(messages));
    data.outcomes.push({ ...data.outcomes[0], status: "needs-user", reason: "Contradictory result." });
    return JSON.stringify(data);
  });
  const before = readDoc(session).toJSON();
  const request = requestBulkComments(session.ydoc);
  await done(session);
  expect(calls).toHaveLength(2);
  expect(agent.jobs(session.docKey)[0].detail).toContain('conflicting duplicate results for comment "C1"');
  expect(readDoc(session).toJSON()).toEqual(before);
  expect(threadsOf(session).find(thread => thread.id === request)?.comments.at(-1)?.text).toContain("No manuscript edits were applied");
});

test("an author edit during automatic metadata repair still discards the proposal", async () => {
  let mutate = () => {};
  const { session } = await setup(async messages => {
    if (String(messages[0].content).includes("Repair only")) mutate();
    const data = JSON.parse(answer(messages));
    if (!String(messages[0].content).includes("Repair only")) data.outcomes[0].threadId = "C999";
    return JSON.stringify(data);
  });
  mutate = () => createThread(session.ydoc.getMap(COLLAB_THREADS_MAP), "me", "A new condition.", { manual: true });
  requestBulkComments(session.ydoc);
  await done(session);
  expect(agent.jobs(session.docKey)[0].detail).toContain("comments changed");
  expect(listChangeSets(readDoc(session))).toHaveLength(0);
});

const changedParagraphs = (session: CollabSession) =>
  listChangeSets(readDoc(session), session.ydoc.getMap(CHANGE_SETS_MAP)).flatMap(set => set.paragraphs.map(paragraph => paragraph.blockId));
const onlyP1 = (messages: OllamaMessage[]) => {
  const data = JSON.parse(answer(messages));
  for (const outcome of data.outcomes) if (outcome.status === "addressed") outcome.blockIds = ["p1"];
  return data;
};

test("a follow-on edit listed under no comment is linked to the comment that required it", async () => {
  const { session, calls, ai, human } = await setup(async messages => {
    const payload = payloadOf(messages);
    if (payload.unlinkedParagraphIds) {
      expect(payload.unlinkedParagraphIds).toEqual(["P2"]);
      return JSON.stringify({ outcomes: JSON.parse(answer(messages)).outcomes, revert: [] });
    }
    return payload.candidateManuscript ? answer(messages) : JSON.stringify(onlyP1(messages));
  });
  requestBulkComments(session.ydoc);
  await done(session);
  expect(agent.jobs(session.docKey)[0].state).toBe("done");
  expect(calls).toHaveLength(3);
  expect(changedParagraphs(session)).toEqual(["p1", "p2"]);
  for (const id of [ai, human]) expect(threadsOf(session).find(thread => thread.id === id)?.meta.status).toBe("proposed");
});

test("an edit no comment required is withdrawn and the rest is verified and proposed", async () => {
  let candidate = "";
  const { session } = await setup(async messages => {
    const payload = payloadOf(messages);
    if (payload.unlinkedParagraphIds) return JSON.stringify({ outcomes: onlyP1(messages).outcomes, revert: ["P2"] });
    if (payload.candidateManuscript) {
      candidate = payload.candidateManuscript.map(paragraph => paragraph.text).join("\n");
      return JSON.stringify({ consistent: true, outcomes: payload.proposedOutcomes });
    }
    return JSON.stringify(onlyP1(messages));
  });
  requestBulkComments(session.ydoc);
  await done(session);
  expect(agent.jobs(session.docKey)[0].state).toBe("done");
  expect(candidate).toContain("These findings suggest");
  expect(candidate).toContain("Our conclusions prove");
  expect(changedParagraphs(session)).toEqual(["p1"]);
});

test("edits for a comment the verification defers are withdrawn and the remainder is checked again", async () => {
  let verifications = 0;
  const { session, ai, human } = await setup(async messages => {
    const payload = payloadOf(messages);
    if (!payload.candidateManuscript) return answer(messages);
    verifications++;
    const outcomes = payload.proposedOutcomes!.map(outcome => outcome.status !== "addressed" ? outcome
      : outcome.reason.includes("Qualified") && payload.comments.find(comment => comment.id === outcome.threadId)!.comments[0].text.includes("conclusion")
        ? { ...outcome, status: "needs-user", reason: "Which conclusion do you want?", blockIds: [] }
        : { ...outcome, blockIds: ["P1"] });
    return JSON.stringify({ consistent: true, outcomes });
  });
  requestBulkComments(session.ydoc);
  await done(session);
  expect(agent.jobs(session.docKey)[0].state).toBe("done");
  expect(verifications).toBe(2);
  expect(changedParagraphs(session)).toEqual(["p1"]);
  expect(threadsOf(session).find(thread => thread.id === ai)?.meta.status).toBe("proposed");
  expect(threadsOf(session).find(thread => thread.id === human)?.meta.status).toBe("open");
});
