import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { OllamaMessage } from "../../../shared/rpc-types";
import type { CollabSession } from "../registry";
import type { BulkSources } from "./bulk-sources";

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
const { readDoc, findBlock, blockContent, writeBlock, anchorThread, threadRange } = await import("./doc-model");
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
  comments: Array<{ id: string; target: boolean; resolved: boolean; comments: Array<{ text: string }> }>;
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
function fakeSources(overrides: Partial<BulkSources> = {}): BulkSources {
  return { documents: async () => [], loadBibtex: async () => "", saveBibtex: async () => {},
    resolveDOI: async doi => { throw new Error(`offline: ${doi}`); }, findCitations: async () => [], ...overrides };
}
async function setup(respond: (messages: OllamaMessage[]) => Promise<string> = async messages => answer(messages), extra = 0, sources = fakeSources()) {
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
  agent = new CollabAgent(registry, { complete: async messages => { calls.push(messages); return respond(messages); }, onActivity: () => {}, pollMs: 1,
    bulkSources: () => sources });
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
  expect(payloadOf(calls[0]).comments.find(comment => comment.comments[0].text.includes("historical"))?.resolved).toBe(true);
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
      data.outcomes.push({ threadId: payload.comments.find(comment => comment.resolved)!.id, status: "resolved" });
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

const BIB = "@article{smith2020trial,\n  author = {Smith, Ann and Lee, Bo},\n  title = {A randomized trial of the hypothesis},\n  journal = {Trials},\n  year = {2020},\n  doi = {10.1000/trial}\n}\n";
const RESOLVED = "@article{kim2021cohort,\n  author = {Kim, Chan},\n  title = {Cohort evidence for the hypothesis},\n  journal = {Epidemiology},\n  year = {2021},\n  doi = {10.1000/cohort}\n}\n";
function citing(cite: string, extra: Record<string, unknown> = {}) {
  return async (messages: OllamaMessage[]) => {
    const data = JSON.parse(answer(messages));
    if (!payloadOf(messages).candidateManuscript) {
      data.edits = data.edits.map((edit: { id: string; text: string }) => ({ ...edit, text: edit.text.replace("hypothesis.", `hypothesis ${cite}.`) }));
      Object.assign(data, extra);
    }
    return JSON.stringify(data);
  };
}
/** `[@` left in a text node means a citation was not turned into a citation node. */
function literalCitationText(session: CollabSession) {
  let found = false;
  readDoc(session).descendants(node => { if (node.isText && node.text!.includes("[@")) found = true; return true; });
  return found;
}
function citationsIn(session: CollabSession) {
  const keys: string[] = [];
  readDoc(session).descendants(node => { if (node.type.name === "citation") keys.push(node.attrs.citekey); return true; });
  return keys;
}

test("the other project documents and references.bib are read before revising", async () => {
  const sources = fakeSources({
    documents: async () => [{ path: "documents/chapter-2.scholarpen.json", text: "Chapter 2 defines the hypothesis as H1." }],
    loadBibtex: async () => BIB,
  });
  const { session, calls } = await setup(undefined, 0, sources);
  requestBulkComments(session.ydoc);
  await done(session);
  const payload = JSON.parse(String(calls[0][1].content));
  expect(payload.projectDocuments).toEqual([{ path: "documents/chapter-2.scholarpen.json", text: "Chapter 2 defines the hypothesis as H1.", truncated: false }]);
  expect(payload.library.entries[0]).toStartWith("smith2020trial: Smith, Ann; Lee, Bo (2020). A randomized trial of the hypothesis.");
  expect(String(calls[0][0].content)).toContain("projectDocuments are the project's OTHER chapters");
  // The verifier checks the revision against the same project.
  expect(JSON.parse(String(calls[1][1].content)).projectDocuments).toHaveLength(1);
});

test("a citation from references.bib is inserted as a structured [@citekey] citation", async () => {
  let saved = false;
  const { session } = await setup(citing("[@Smith2020Trial, p. 4]"), 0, fakeSources({ loadBibtex: async () => BIB, saveBibtex: async () => { saved = true; } }));
  requestBulkComments(session.ydoc);
  await done(session);
  expect(agent.jobs(session.docKey)[0].state).toBe("done");
  expect(citationsIn(session)).toEqual(["smith2020trial", "smith2020trial"]);
  let locator = "";
  readDoc(session).descendants(node => { if (node.type.name === "citation") locator = node.attrs.locator; return true; });
  expect(locator).toBe("p. 4");
  expect(literalCitationText(session)).toBe(false);
  expect(saved).toBe(false);
  expect(listChangeSets(readDoc(session))).toHaveLength(1);
  expect(agent.undoLast(session.docKey)).toBe(true);
  expect(citationsIn(session)).toEqual([]);
});

test("a new work is verified and added to references.bib before it is cited", async () => {
  let bib = BIB;
  const events: string[] = [];
  let session!: CollabSession;
  const sources = fakeSources({
    loadBibtex: async () => bib,
    saveBibtex: async (next, expected) => {
      expect(expected).toBe(bib);
      events.push(`saved with ${citationsIn(session).length} citations in the text`);
      bib = next;
    },
    resolveDOI: async doi => {
      events.push(`resolved ${doi}`);
      return { doi, citekey: "kim2021cohort", title: "Cohort evidence for the hypothesis", authors: ["Kim, Chan"], year: 2021, journal: "Epidemiology", bibtex: RESOLVED };
    },
  });
  ({ session } = await setup(citing("[@doi:10.1000/cohort]", {
    newReferences: [{ doi: "10.1000/cohort", title: "Cohort evidence for the hypothesis", reason: "Supports the qualified claim." }],
  }), 0, sources));
  const request = requestBulkComments(session.ydoc);
  await done(session);
  expect(agent.jobs(session.docKey)[0].state).toBe("done");
  expect(events).toEqual(["resolved 10.1000/cohort", "saved with 0 citations in the text"]);
  expect(bib).toContain("@article{smith2020trial");
  expect(bib).toContain("@article{kim2021cohort");
  expect(citationsIn(session)).toEqual(["kim2021cohort", "kim2021cohort"]);
  expect(threadsOf(session).find(thread => thread.id === request)?.comments.at(-1)?.text).toContain("Added to references.bib before citing: @kim2021cohort");
});

test("a DOI already in references.bib reuses its citekey without touching the file", async () => {
  let saved = false;
  const { session } = await setup(citing("[@doi:10.1000/TRIAL]"), 0, fakeSources({ loadBibtex: async () => BIB, saveBibtex: async () => { saved = true; } }));
  requestBulkComments(session.ydoc);
  await done(session);
  expect(citationsIn(session)).toEqual(["smith2020trial", "smith2020trial"]);
  expect(saved).toBe(false);
});

for (const kind of ["unknown citekey", "unverifiable DOI", "mismatched title", "no bibliography"] as const) {
  test(`an ${kind} is removed from the text and reported, never cited`, async () => {
    let saved = false;
    const cite = kind === "unknown citekey" ? "[@ghost1999]" : "[@doi:10.1000/cohort]";
    const sources = fakeSources({
      loadBibtex: async () => { if (kind === "no bibliography") throw new Error("unreadable"); return BIB; },
      saveBibtex: async () => { saved = true; },
      resolveDOI: async doi => {
        if (kind === "unverifiable DOI") throw new Error("CrossRef error: HTTP 404");
        return { doi, citekey: "kim2021cohort", title: "An unrelated study of fish", authors: [], year: 2021, bibtex: RESOLVED };
      },
    });
    const { session } = await setup(citing(cite, { newReferences: [{ doi: "10.1000/cohort", title: "Cohort evidence for the hypothesis" }] }), 0, sources);
    const request = requestBulkComments(session.ydoc);
    await done(session);
    expect(agent.jobs(session.docKey)[0].state).toBe("done");
    expect(citationsIn(session)).toEqual([]);
    expect(literalCitationText(session)).toBe(false);
    expect(readDoc(session).textContent).toContain("suggest the hypothesis.");
    expect(saved).toBe(false);
    expect(threadsOf(session).find(thread => thread.id === request)?.comments.at(-1)?.text).toContain("Removed citations that could not be verified");
  });
}

test("comments asking for evidence get searched candidates, marked when already in the library", async () => {
  const searched: string[] = [];
  const sources = fakeSources({
    loadBibtex: async () => BIB,
    findCitations: async passage => {
      searched.push(passage);
      return [
        { doi: "10.1000/trial", title: "A randomized trial of the hypothesis", authors: ["Smith, Ann"], year: 2020, source: "OpenAlex" },
        { doi: "10.1000/cohort", title: "Cohort evidence for the hypothesis", authors: ["Kim, Chan"], year: 2021, source: "Crossref" },
      ];
    },
  });
  const { session, calls } = await setup(undefined, 0, sources);
  createThread(session.ydoc.getMap(COLLAB_THREADS_MAP), AI_USER_ID, "This claim needs a citation.", { assignee: "me", blockId: "p2" });
  requestBulkComments(session.ydoc);
  await done(session);
  expect(searched).toEqual(["Our conclusions prove the hypothesis."]);
  const candidates = JSON.parse(String(calls[0][1].content)).citationCandidates;
  expect(candidates.map((item: { doi: string; citekey?: string }) => [item.doi, item.citekey])).toEqual([["10.1000/trial", "smith2020trial"], ["10.1000/cohort", undefined]]);
});

const { REVISIONS_MAP, readRevisions } = await import("../../../shared/collab/revision-log");
const { WRITING_MAP } = await import("../../../shared/collab/writing");

test("needs-user outcomes enter the decision queue and the revision is logged at its edit level", async () => {
  const { session, ai, decision } = await setup();
  requestBulkComments(session.ydoc);
  await done(session);
  expect(threadsOf(session).find(thread => thread.id === decision)?.meta.decision?.question).toBe("Which primary endpoint do you intend?");
  expect(threadsOf(session).find(thread => thread.id === ai)?.meta.decision).toBeUndefined();
  const [entry] = readRevisions(session.ydoc.getMap(REVISIONS_MAP));
  expect(entry).toMatchObject({ kind: "coordinated", status: "pending", level: "sentence" });
  expect(entry.items.map(item => item.outcome).sort()).toEqual(["addressed", "addressed", "needs-user"]);
  expect(entry.items.find(item => item.threadId === ai)).toMatchObject({ comment: "Qualify the causal inference.", commentBy: "ai" });
  expect(entry.paragraphs.map(paragraph => paragraph.blockId)).toEqual(["p1", "p2"]);
});

test("the Proofread level keeps a paragraph rewrite out and the affected comment open", async () => {
  const { session, calls, ai, human } = await setup(async messages => {
    const payload = payloadOf(messages);
    if (String(messages[0].content).includes("Repair only")) {
      return JSON.stringify({ outcomes: payload.comments.filter(comment => comment.target).map(comment => comment.comments[0].text.includes("Qualify")
        ? { threadId: comment.id, status: "addressed", reason: "Corrected the wording.", blockIds: ["P2"] }
        : { threadId: comment.id, status: "needs-user", reason: "This needs a larger rewrite; raise the edit level?", blockIds: [] }) });
    }
    if (payload.candidateManuscript) return JSON.stringify({ consistent: true, outcomes: payload.proposedOutcomes });
    return JSON.stringify({ summary: "Revise.", edits: [
      { id: payload.editable_segments[0].id, text: "A wholly different opening statement about unrelated matters." },
      { id: payload.editable_segments[1].id, text: payload.editable_segments[1].text.replace("prove", "suggest") },
    ], outcomes: payload.comments.filter(comment => comment.target).map(comment => ({ threadId: comment.id, status: "addressed", reason: "Done.", blockIds: ["P1", "P2"] })) });
  });
  session.ydoc.getMap(WRITING_MAP).set("editLevel", "proofread");
  const request = requestBulkComments(session.ydoc);
  await done(session);
  expect(agent.jobs(session.docKey)[0].state).toBe("done");
  expect(String(calls[0][0].content)).toContain("EDIT LEVEL: PROOFREAD");
  expect(readDoc(session).textContent).toContain("These findings prove the hypothesis.");
  expect(readDoc(session).textContent).not.toContain("wholly different");
  expect(threadsOf(session).find(thread => thread.id === ai)?.meta.status).toBe("proposed");
  expect(threadsOf(session).find(thread => thread.id === human)?.meta.decision?.question).toContain("raise the edit level");
  expect(threadsOf(session).find(thread => thread.id === request)?.comments.at(-1)?.text).toContain("exceeded the Proofread edit level");
});

const { postIssues } = await import("./project-consistency");

test("consistency issues of an open document become anchored comments, never posted twice", async () => {
  const { session } = await setup();
  const issue = { id: "x", kind: "contradiction" as const, filename: "doc.scholarpen.json", blockId: "p1", quote: "prove the hypothesis",
    comment: "Chapter 3 calls this preliminary.", related: { filename: "ch3.scholarpen.json", quote: "preliminary evidence" } };
  expect(postIssues([session], [issue, { ...issue, filename: "other.scholarpen.json" }])).toBe(1);
  expect(postIssues([session], [issue])).toBe(0);
  const thread = threadsOf(session).find(item => item.meta.fingerprint?.startsWith("consistency:"))!;
  expect(thread.comments[0].text).toContain('See ch3.scholarpen.json: "preliminary evidence"');
  const range = threadRange(readDoc(session), thread.id)!;
  expect(readDoc(session).textBetween(range.from, range.to)).toBe("prove the hypothesis");
});
