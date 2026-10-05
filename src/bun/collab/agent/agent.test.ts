import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { EditorState } from "prosemirror-state";
import type { OllamaMessage } from "../../../shared/rpc-types";

// The webview's real schema is needed to build realistic documents; everything
// under test afterwards runs on Bun's render-less copy of it.
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
const { readDoc, findBlock, blockContent, writeBlock, threadRange } = await import("./doc-model");
const { schemaToSpecJSON } = await import("../../../shared/collab/schema-spec");
const { COLLAB_THREADS_MAP } = await import("../../../shared/collab/protocol");
const { createThread, readThreads, AI_USER_ID } = await import("../../../shared/collab/threads");

const editor = getHeadlessEditor();
const schemaSpec = schemaToSpecJSON(editor.pmSchema);

const BLOCKS = [
  { id: "p1", type: "paragraph", content: "These results prove that the drug causes recovery in all patients." },
  { id: "p2", type: "paragraph", content: [
    { type: "text", text: "Earlier trials reported similar effects ", styles: {} },
    { type: "citation", props: { citekey: "smith2020", locator: "" } },
    { type: "text", text: " in small samples.", styles: {} },
  ] },
  { id: "p3", type: "paragraph", content: "We recieve the data from three sites." },
];

let registry: InstanceType<typeof CollabRegistry>;
let agent: InstanceType<typeof CollabAgent> | null = null;
afterEach(async () => {
  agent?.dispose();
  agent = null;
  await registry?.dispose();
});

async function setup(complete: (messages: OllamaMessage[]) => Promise<string>, options: { waitForAuthorMs?: number } = {}) {
  const seeded = blocksToYDoc(editor, BLOCKS as any, "document-store");
  registry = new CollabRegistry({
    read: async () => ({ state: Y.encodeStateAsUpdate(seeded), meta: { jsonHash: "h", updatedAt: 0 } }),
    write: async () => {},
    jsonHash: async () => "h",
  }, { update: () => {}, awareness: () => {} });
  await registry.open({ projectPath: "/p", filename: "doc.scholarpen.json", peerId: "editor", schema: schemaSpec });
  const session = registry.get("/p::doc.scholarpen.json")!;
  const prompts: OllamaMessage[][] = [];
  agent = new CollabAgent(registry, {
    complete: async (messages) => { prompts.push(messages); return complete(messages); },
    onActivity: () => {},
    pollMs: 10,
    waitForAuthorMs: options.waitForAuthorMs ?? 2000,
  });
  return { session, prompts };
}

/** Simulates the author's editor: comment on a block's full text. */
function comment(session: any, blockId: string, text: string) {
  const threads = session.ydoc.getMap(COLLAB_THREADS_MAP);
  let threadId = "";
  session.ydoc.transact(() => { threadId = createThread(threads, "me", text, {}); }, "editor");
  const doc = readDoc(session);
  const block = findBlock(doc, blockId)!;
  const content = blockContent(block);
  const state = EditorState.create({ schema: session.schema, doc });
  const tr = state.tr.addMark(content.from, content.to, session.schema.marks.comment.create({ threadId, orphan: false }));
  writeBlock(session, tr.doc.nodeAt(block.pos)!, "editor");
  return threadId;
}

/** Simulates the author typing: replace words in a block's first text node. */
function authorEdit(session: any, blockId: string, find: string, replace: string) {
  const doc = readDoc(session);
  const block = findBlock(doc, blockId)!;
  const content = blockContent(block);
  let at = -1;
  content.node.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.includes(find)) at = content.from + pos + node.text!.indexOf(find);
  });
  const state = EditorState.create({ schema: session.schema, doc });
  const tr = state.tr.insertText(replace, at, at + find.length);
  writeBlock(session, tr.doc.nodeAt(block.pos)!, "editor");
}

/** The model echoes the passage with a text substitution, keeping every marker. */
function rewrite(messages: OllamaMessage[], from: string, to: string, reply = "Softened the claim.") {
  const user = messages[1].content as string;
  const passage = user.match(/<passage_to_edit>\n([\s\S]*?)\n<\/passage_to_edit>/)![1];
  return `<reply>${reply}</reply>\n<passage>${passage.replace(from, to)}</passage>`;
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

function marks(session: any, blockId: string) {
  const out: Array<{ text: string; mark: string }> = [];
  blockContent(findBlock(readDoc(session), blockId)!).node.descendants((node) => {
    if (node.isText) out.push({ text: node.text!, mark: node.marks.map((m) => m.type.name).filter((n) => n !== "comment").join(",") });
    return true;
  });
  return out;
}

const threadOf = (session: any, id: string) => readThreads(session.ydoc.getMap(COLLAB_THREADS_MAP)).find((t) => t.id === id)!;

test("a comment for the AI becomes a tracked suggestion and a thread reply", async () => {
  const { session, prompts } = await setup(async (messages) => rewrite(messages, "prove that the drug causes", "suggest that the drug may support"));
  const threadId = comment(session, "p1", "@AI this overclaims, soften it");
  await waitFor(() => threadOf(session, threadId).comments.length === 2);

  expect(prompts[0][1].content).toContain("@AI this overclaims");
  const thread = threadOf(session, threadId);
  expect(thread.comments[1].userId).toBe(AI_USER_ID);
  expect(thread.comments[1].text).toContain("Softened the claim.");
  expect(thread.meta).toMatchObject({ status: "proposed", assignee: "me" });
  const parts = marks(session, "p1");
  expect(parts.filter((p) => p.mark === "deletion").map((p) => p.text).join("|")).toContain("prove");
  expect(parts.filter((p) => p.mark === "insertion").map((p) => p.text).join("|")).toContain("suggest");
  // The comment still anchors the passage.
  expect(threadRange(readDoc(session), threadId)).not.toBeNull();
  // Every change of this request carries one id: the change set the thread points to.
  const ids = new Set<number>();
  blockContent(findBlock(readDoc(session), "p1")!).node.descendants((node) => {
    node.marks.forEach((mark) => { if (mark.type.name === "insertion" || mark.type.name === "deletion") ids.add(mark.attrs.id); });
    return true;
  });
  expect([...ids]).toEqual([thread.meta.changeSet!]);
  expect(session.ydoc.getMap("changeSets").get(String(thread.meta.changeSet))).toMatchObject({ threadId, persona: "scholarpen-ai" });
});

test("a rewrite of most of a paragraph is one replaced span, not a patchwork of words", async () => {
  const { session } = await setup(async (messages) => rewrite(messages,
    "These results prove that the drug causes recovery in all patients.",
    "In this cohort, recovery was more frequent among treated patients, although causality remains uncertain."));
  const threadId = comment(session, "p1", "@AI rewrite this paragraph");
  await waitFor(() => threadOf(session, threadId).comments.length === 2);
  const parts = marks(session, "p1").filter((p) => p.mark);
  expect(parts.map((p) => p.mark)).toEqual(["deletion", "insertion"]);
});

test("citations survive and concurrent edits elsewhere in the paragraph are merged", async () => {
  let session: any;
  ({ session } = await setup(async (messages) => {
    // The author edits other words of the same paragraph while the model is thinking.
    authorEdit(session, "p2", "small samples", "small, short samples");
    return rewrite(messages, "similar effects", "comparable effects");
  }));
  const threadId = comment(session, "p2", "@AI tighten the wording");
  await waitFor(() => threadOf(session, threadId).comments.length === 2);

  const block = blockContent(findBlock(readDoc(session), "p2")!).node;
  expect(block.textContent).toContain("small, short samples");
  let citation = 0;
  block.descendants((node) => { if (node.type.name === "citation") citation++; return true; });
  expect(citation).toBe(1);
  expect(marks(session, "p2").some((p) => p.mark === "insertion" && p.text.includes("comparable"))).toBe(true);
  expect(threadOf(session, threadId).comments[1].text).toContain("merged my changes around yours");
});

test("an edit to the same words while the AI works is downgraded to a proposal", async () => {
  let session: any;
  ({ session } = await setup(async (messages) => {
    authorEdit(session, "p1", "prove", "show");
    return rewrite(messages, "prove that the drug causes", "suggest that the drug may support");
  }));
  const threadId = comment(session, "p1", "@AI soften this");
  await waitFor(() => threadOf(session, threadId).comments.length === 2);

  const thread = threadOf(session, threadId);
  expect(thread.comments[1].text).toContain("I didn't change the text");
  expect(thread.comments[1].text).toContain("suggest that the drug may support");
  expect(thread.meta.status).toBe("proposed");
  expect(marks(session, "p1").every((p) => p.mark === "")).toBe(true);
  expect(blockContent(findBlock(readDoc(session), "p1")!).node.textContent).toContain("show that the drug causes");
});

test("typo fixes apply directly and can be undone", async () => {
  const { session } = await setup(async (messages) => rewrite(messages, "recieve", "receive", "Fixed a typo."));
  const threadId = comment(session, "p3", "@AI typo?");
  await waitFor(() => threadOf(session, threadId).comments.length === 2);

  expect(blockContent(findBlock(readDoc(session), "p3")!).node.textContent).toBe("We receive the data from three sites.");
  expect(marks(session, "p3").every((p) => p.mark === "")).toBe(true);
  expect(session.ydoc.getMap("aiEdits").has("p3")).toBe(true);
  expect(agent!.undoLast(session.docKey)).toBe(true);
  expect(blockContent(findBlock(readDoc(session), "p3")!).node.textContent).toBe("We recieve the data from three sites.");
});

test("the AI waits while the author is typing in the paragraph", async () => {
  const { session, prompts } = await setup(async (messages) => rewrite(messages, "recieve", "receive"), { waitForAuthorMs: 5000 });
  // Typing in p3 right before the request.
  authorEdit(session, "p3", "three", "four");
  const threadId = comment(session, "p3", "@AI typo?");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(prompts.length).toBe(0);
  expect(agent!.jobs(session.docKey)[0].state).toBe("waiting");
  expect(threadOf(session, threadId).meta.status).toBe("in-progress");
}, 10_000);
