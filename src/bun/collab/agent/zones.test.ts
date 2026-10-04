import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
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
const { blocksToYDoc, yDocToBlocks } = await import("@blocknote/core/yjs");
const Y = await import("yjs");
const { CollabRegistry } = await import("../registry");
const { CollabAgent } = await import("./agent");
const { zoneEditMode, enqueueDraft, paragraphContent } = await import("./zones");
const { readDoc, findBlock, blockContent, anchorThread, threadRange } = await import("./doc-model");
const { schemaToSpecJSON } = await import("../../../shared/collab/schema-spec");
const { COLLAB_THREADS_MAP } = await import("../../../shared/collab/protocol");
const { createThread, readThreads } = await import("../../../shared/collab/threads");
const { ZONES_MAP } = await import("../../../shared/collab/zones");

const editor = getHeadlessEditor();
const schemaSpec = schemaToSpecJSON(editor.pmSchema);
const BLOCKS = [
  { id: "intro", type: "heading", props: { level: 1 }, content: "Introduction" },
  { id: "i1", type: "paragraph", content: "We recieve the claim that it works." },
  { id: "methods", type: "heading", props: { level: 1 }, content: "Methods" },
  { id: "m1", type: "bulletListItem", content: "n=40 adults, 2 sites [@kim2021]" },
  { id: "m2", type: "bulletListItem", content: "8-week RCT" },
  { id: "results", type: "heading", props: { level: 1 }, content: "Results" },
  { id: "r1", type: "paragraph", content: "The effect was large." },
];

let registry: InstanceType<typeof CollabRegistry>;
let agent: InstanceType<typeof CollabAgent>;
afterEach(async () => {
  agent?.dispose();
  await registry?.dispose();
});

async function setup(complete: (messages: OllamaMessage[]) => Promise<string>) {
  const seeded = blocksToYDoc(editor, BLOCKS as any, "document-store");
  registry = new CollabRegistry({
    read: async () => ({ state: Y.encodeStateAsUpdate(seeded), meta: { jsonHash: "h", updatedAt: 0 } }),
    write: async () => {},
    jsonHash: async () => "h",
  }, { update: () => {}, awareness: () => {} });
  await registry.open({ projectPath: "/p", filename: "doc.scholarpen.json", peerId: "editor", schema: schemaSpec });
  const session = registry.get("/p::doc.scholarpen.json")!;
  agent = new CollabAgent(registry, { complete: async (m) => complete(m), onActivity: () => {}, pollMs: 5, waitForAuthorMs: 20, editModeFor: zoneEditMode });
  return session;
}

function ask(session: any, blockId: string, text: string) {
  const threads = session.ydoc.getMap(COLLAB_THREADS_MAP);
  let id = "";
  session.ydoc.transact(() => { id = createThread(threads, "me", text, {}); }, "editor");
  anchorThread(session, blockId, id, "editor");
  return id;
}

const replace = (from: string, to: string) => async (messages: OllamaMessage[]) => {
  const passage = (messages[1].content as string).match(/<passage_to_edit>\n([\s\S]*?)\n<\/passage_to_edit>/)![1];
  return `<reply>Done.</reply><passage>${passage.replace(from, to)}</passage>`;
};

async function answered(session: any, id: string) {
  for (let i = 0; i < 200; i++) {
    const thread = readThreads(session.ydoc.getMap(COLLAB_THREADS_MAP)).find((t) => t.id === id);
    if (thread && thread.comments.length > 1) return thread;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no answer");
}

function markNames(session: any, blockId: string) {
  const names = new Set<string>();
  blockContent(findBlock(readDoc(session), blockId)!).node.descendants((node) => {
    node.marks.forEach((mark) => names.add(mark.type.name));
    return true;
  });
  return names;
}

test("observe zones get proposals, never text changes", async () => {
  const session = await setup(replace("recieve", "receive"));
  session.ydoc.getMap(ZONES_MAP).set("intro", { trust: "observe" });
  const thread = await answered(session, ask(session, "i1", "@AI typo"));
  expect(thread.meta.statusNote).toContain("Observe");
  expect(thread.comments[1].text).toContain("We receive the claim");
  expect(blockContent(findBlock(readDoc(session), "i1")!).node.textContent).toBe("We recieve the claim that it works.");
});

test("suggest zones turn even typo fixes into suggestions", async () => {
  const session = await setup(replace("recieve", "receive"));
  session.ydoc.getMap(ZONES_MAP).set("intro", { trust: "suggest" });
  await answered(session, ask(session, "i1", "@AI typo"));
  expect(markNames(session, "i1").has("insertion")).toBe(true);
});

test("edit zones apply content edits directly and mark them", async () => {
  const session = await setup(replace("The effect was large.", "The effect was moderate (d = 0.5)."));
  session.ydoc.getMap(ZONES_MAP).set("results", { trust: "edit" });
  await answered(session, ask(session, "r1", "@AI be precise"));
  expect(blockContent(findBlock(readDoc(session), "r1")!).node.textContent).toBe("The effect was moderate (d = 0.5).");
  expect(markNames(session, "r1").has("insertion")).toBe(false);
  expect(session.ydoc.getMap("aiEdits").has("r1")).toBe(true);
});

test("the AI drafts a section it owns from the author's notes", async () => {
  let prompt = "";
  const session = await setup(async (messages) => {
    prompt = messages[1].content as string;
    return "We enrolled 40 adults at two sites [@kim2021].\n\nThe trial ran for eight weeks [TODO: dates].";
  });
  expect(() => enqueueDraft(agent, session.docKey, "m1", async () => "")).toThrow("AI drafts");
  session.ydoc.getMap(ZONES_MAP).set("methods", { trust: "edit", brief: "Concise, past tense." });
  enqueueDraft(agent, session.docKey, "m2", async (messages) => (agent as any).deps.complete(messages));
  for (let i = 0; i < 200 && agent.isBusy(session.docKey); i++) await new Promise((r) => setTimeout(r, 10));

  expect(prompt).toContain("n=40 adults, 2 sites [@kim2021]");
  expect(prompt).toContain("Concise, past tense.");
  const blocks = yDocToBlocks(editor, session.ydoc, "document-store") as any[];
  const ids = blocks.map((block) => block.id);
  // Drafted paragraphs follow the notes and precede the next section.
  const drafted = blocks.slice(ids.indexOf("m2") + 1, ids.indexOf("results"));
  expect(drafted).toHaveLength(2);
  expect(drafted[0].content.map((part: any) => part.type)).toEqual(["text", "citation", "text"]);
  expect(drafted[0].content[1].props.citekey).toBe("kim2021");
  expect(blocks.find((block) => block.id === "m1")).toBeDefined();
  const thread = readThreads(session.ydoc.getMap(COLLAB_THREADS_MAP)).find((t) => t.meta.category === "draft")!;
  expect(threadRange(readDoc(session), thread.id)).not.toBeNull();
  expect(agent.undoLast(session.docKey)).toBe(true);
  expect((yDocToBlocks(editor, session.ydoc, "document-store") as any[]).length).toBe(BLOCKS.length);
});

test("citations in drafts become citation nodes", () => {
  const nodes = paragraphContent(editor.pmSchema, "As shown [@a; @b, p. 3].");
  expect(nodes.map((node) => node.type.name)).toEqual(["text", "citation", "citation", "text"]);
  expect(nodes[2].attrs).toMatchObject({ citekey: "b", locator: "p. 3" });
});
