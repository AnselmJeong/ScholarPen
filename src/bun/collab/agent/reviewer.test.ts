import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { EditorState } from "prosemirror-state";
import type { OllamaMessage } from "../../../shared/rpc-types";

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

const { getHeadlessEditor } = await import("../../../renderer/collab/collab-peer");
const { blocksToYDoc } = await import("@blocknote/core/yjs");
const Y = await import("yjs");
const { CollabRegistry } = await import("../registry");
const { CollabAgent } = await import("./agent");
const { Reviewer } = await import("./reviewer");
const { readDoc, findBlock, blockContent, writeBlock, threadRange } = await import("./doc-model");
const { schemaToSpecJSON } = await import("../../../shared/collab/schema-spec");
const { COLLAB_THREADS_MAP } = await import("../../../shared/collab/protocol");
const { readThreads, updateThreadMeta, AI_USER_ID } = await import("../../../shared/collab/threads");
const { REVIEW_MAP } = await import("../../../shared/collab/review");

const editor = getHeadlessEditor();
const schemaSpec = schemaToSpecJSON(editor.pmSchema);
const BLOCKS = [
  { id: "h1", type: "heading", props: { level: 1 }, content: "Results" },
  { id: "p1", type: "paragraph", content: "Our findings prove that the treatment works in every patient." },
  { id: "p2", type: "paragraph", content: [
    { type: "text", text: "Prior work agrees ", styles: {} },
    { type: "citation", props: { citekey: "ghost2019", locator: "" } },
    { type: "text", text: ".", styles: {} },
  ] },
  { id: "h2", type: "heading", props: { level: 1 }, content: "Discussion" },
  { id: "p3", type: "paragraph", content: "This is a separate section." },
];

let registry: InstanceType<typeof CollabRegistry>;
let agent: InstanceType<typeof CollabAgent>;
let reviewer: InstanceType<typeof Reviewer>;
afterEach(async () => {
  reviewer?.dispose();
  agent?.dispose();
  await registry?.dispose();
});

async function setup(complete: (messages: OllamaMessage[]) => Promise<string>, clock = { now: Date.now() }) {
  const seeded = blocksToYDoc(editor, BLOCKS as any, "document-store");
  registry = new CollabRegistry({
    read: async () => ({ state: Y.encodeStateAsUpdate(seeded), meta: { jsonHash: "h", updatedAt: 0 } }),
    write: async () => {},
    jsonHash: async () => "h",
  }, { update: () => {}, awareness: () => {} });
  await registry.open({ projectPath: "/p", filename: "doc.scholarpen.json", peerId: "editor", schema: schemaSpec });
  const session = registry.get("/p::doc.scholarpen.json")!;
  const prompts: OllamaMessage[][] = [];
  const respond = async (messages: OllamaMessage[]) => { prompts.push(messages); return complete(messages); };
  agent = new CollabAgent(registry, { complete: respond, onActivity: () => {}, pollMs: 5, waitForAuthorMs: 50, now: () => clock.now });
  reviewer = new Reviewer(agent, {
    complete: respond,
    citekeys: async () => new Set(["real2020"]),
    now: () => clock.now,
    tickMs: 0,
  });
  return { session, prompts };
}

const findings = (items: unknown[]) => async () => JSON.stringify({ findings: items });
const threads = (session: any) => readThreads(session.ydoc.getMap(COLLAB_THREADS_MAP));

async function idle() {
  for (let i = 0; i < 100 && agent.isBusy("/p::doc.scholarpen.json"); i++) await new Promise((r) => setTimeout(r, 10));
}

test("a section review posts anchored AI threads within the fatigue limits", async () => {
  const { session, prompts } = await setup(findings([
    { paragraph: 1, quote: "prove that the treatment works in every patient", category: "overclaim", severity: "high", comment: "This overstates the evidence." },
    { paragraph: 1, quote: "Our findings", category: "definition", severity: "low", comment: "Minor point." },
    { paragraph: 2, quote: "not in the text", category: "logic", severity: "medium", comment: "Unclear link." },
  ]));
  reviewer.reviewSection(session.docKey, "p1");
  await idle();

  // Only the Results section was sent.
  const reviewed = (prompts[0][1].content as string).split("<rest_of_manuscript")[0];
  expect(reviewed).toContain('<section title="Results">');
  expect(reviewed).toContain('<paragraph n="1">\nOur findings prove');
  expect(reviewed).not.toContain("separate section");

  const posted = threads(session);
  expect(posted.map((t) => t.meta.category).sort()).toEqual(["citation", "logic", "overclaim"]);
  expect(posted.every((t) => t.comments[0].userId === AI_USER_ID && t.meta.assignee === "me")).toBe(true);
  expect(posted.find((t) => t.meta.category === "citation")!.comments[0].text).toContain("@ghost2019 is not in references.bib");

  // The overclaim is anchored to the quoted words; the unmatched quote falls back to its paragraph.
  const doc = readDoc(session);
  const overclaim = posted.find((t) => t.meta.category === "overclaim")!;
  const range = threadRange(doc, overclaim.id)!;
  expect(doc.textBetween(range.from, range.to)).toBe("prove that the treatment works in every patient");
  const logic = posted.find((t) => t.meta.category === "logic")!;
  expect(threadRange(doc, logic.id)).not.toBeNull();

  // Reviewing again posts nothing new: duplicates and the per-section cap.
  reviewer.reviewSection(session.docKey, "p1");
  await idle();
  expect(threads(session)).toHaveLength(3);
});

test("muted categories and resolved findings are not raised again", async () => {
  const { session } = await setup(findings([
    { paragraph: 1, quote: "prove that the treatment works", category: "overclaim", severity: "high", comment: "Too strong." },
  ]));
  session.ydoc.getMap(REVIEW_MAP).set("muted", ["citation"]);
  reviewer.reviewSection(session.docKey, "p1");
  await idle();
  expect(threads(session).map((t) => t.meta.category)).toEqual(["overclaim"]);

  const map = session.ydoc.getMap(COLLAB_THREADS_MAP);
  session.ydoc.transact(() => updateThreadMeta(map, threads(session)[0].id, { status: "resolved" }), "editor");
  reviewer.reviewSection(session.docKey, "p1");
  await idle();
  expect(threads(session)).toHaveLength(1);
});

test("sections are reviewed automatically only after the author leaves them", async () => {
  const clock = { now: 1_000_000 };
  const { session, prompts } = await setup(findings([]), clock);
  // The author types in the Discussion section.
  const doc = readDoc(session);
  const block = findBlock(doc, "p3")!;
  const content = blockContent(block);
  const state = EditorState.create({ schema: session.schema, doc });
  writeBlock(session, state.tr.insertText(" More.", content.to).doc.nodeAt(block.pos)!, "editor");

  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(0);

  clock.now += 120_000;
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(1);
  expect(prompts[0][1].content).toContain("This is a separate section. More.");

  // Unchanged since the last review: nothing more to do.
  clock.now += 600_000;
  reviewer.tick();
  await idle();
  expect(prompts).toHaveLength(1);
});

test("the author can hand an AI finding back to the AI to fix", async () => {
  let step = 0;
  const { session } = await setup(async (messages) => {
    step++;
    if (step === 1) return JSON.stringify({ findings: [
      { paragraph: 1, quote: "prove that the treatment works in every patient", category: "overclaim", severity: "high", comment: "Overstated." },
    ] });
    const passage = (messages[1].content as string).match(/<passage_to_edit>\n([\s\S]*?)\n<\/passage_to_edit>/)![1];
    expect(messages[1].content).toContain("Overstated.");
    return `<reply>Hedged.</reply><passage>${passage.replace("prove that the treatment works in every patient", "suggest the treatment helps many patients")}</passage>`;
  });
  session.ydoc.getMap(REVIEW_MAP).set("muted", ["citation"]);
  reviewer.reviewSection(session.docKey, "p1");
  await idle();
  const finding = threads(session)[0];
  session.ydoc.transact(() => updateThreadMeta(session.ydoc.getMap(COLLAB_THREADS_MAP), finding.id,
    { assignee: "ai", status: "open", requestedAt: Date.now() }), "editor");
  for (let i = 0; i < 100 && threads(session)[0].comments.length < 2; i++) await new Promise((r) => setTimeout(r, 10));

  expect(threads(session)[0].comments[1].text).toContain("Hedged.");
  let inserted = "";
  blockContent(findBlock(readDoc(session), "p1")!).node.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === "insertion")) inserted += node.text;
    return true;
  });
  expect(inserted).toContain("suggest");
});
