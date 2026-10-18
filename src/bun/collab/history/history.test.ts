import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { EditorState } from "prosemirror-state";

// The webview's real schema builds realistic documents; the history runs on Bun's copy of it.
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
const { Node: PMNode } = await import("prosemirror-model");
const { CollabRegistry } = await import("../registry");
const { DocumentHistory } = await import("./history");
const { readDoc, findBlock, blockContent, writeBlock } = await import("./../agent/doc-model");
const { schemaToSpecJSON } = await import("../../../shared/collab/schema-spec");
const { blockTexts } = await import("../../../shared/collab/history");
type HistoryIndex = import("./store").HistoryIndex;
type HistoryStorage = import("./store").HistoryStorage;
type Session = import("../registry").CollabSession;

const editor = getHeadlessEditor();
const schemaSpec = schemaToSpecJSON(editor.pmSchema);

const BLOCKS = [
  { id: "p1", type: "paragraph", content: "The first paragraph." },
  { id: "p2", type: "paragraph", content: "The second paragraph." },
  { id: "p3", type: "paragraph", content: "The third paragraph." },
];

function memoryHistory() {
  const indexes = new Map<string, HistoryIndex>();
  const chunks = new Map<string, Uint8Array>();
  const archived: string[] = [];
  const key = (projectPath: string, filename: string) => `${projectPath}/${filename}`;
  const storage: HistoryStorage = {
    async readIndex(p, f) { const index = indexes.get(key(p, f)); return index ? structuredClone(index) : null; },
    async writeIndex(p, f, index) { indexes.set(key(p, f), structuredClone(index)); },
    async readChunk(p, f, seq) { return chunks.get(`${key(p, f)}#${seq}`) ?? null; },
    async writeChunk(p, f, seq, data) { chunks.set(`${key(p, f)}#${seq}`, data); },
    async deleteChunk(p, f, seq) { chunks.delete(`${key(p, f)}#${seq}`); },
    async archive(p, f) {
      archived.push(key(p, f));
      indexes.delete(key(p, f));
      for (const name of [...chunks.keys()]) if (name.startsWith(`${key(p, f)}#`)) chunks.delete(name);
    },
  };
  return { storage, indexes, chunks, archived };
}

const registries: InstanceType<typeof CollabRegistry>[] = [];
const histories: InstanceType<typeof DocumentHistory>[] = [];
afterEach(async () => {
  for (const history of histories.splice(0)) await history.close();
  for (const registry of registries.splice(0)) await registry.dispose();
});

let clock = 1_000_000;
const now = () => clock;

async function openSession(state: Uint8Array | null) {
  const registry = new CollabRegistry({
    read: async () => ({ state, meta: { jsonHash: "h", updatedAt: 0 } }),
    write: async () => {},
    jsonHash: async () => "h",
  }, { update: () => {}, awareness: () => {} });
  registries.push(registry);
  await registry.open({ projectPath: "/p", filename: "doc.scholarpen.json", peerId: "editor", schema: schemaSpec });
  return registry.get("/p::doc.scholarpen.json")!;
}

function startHistory(session: Session, storage: HistoryStorage, aiLabel?: string) {
  const history = new DocumentHistory(session, storage, { now, aiLabel: () => aiLabel, idleMs: 10_000, maxEntryMs: 300_000 });
  histories.push(history);
  return history;
}

function seeded() {
  return Y.encodeStateAsUpdate(blocksToYDoc(editor, BLOCKS as any, "document-store"));
}

/** Replaces a block's text, as the author (origin "editor") or the AI ("ai-agent") would. */
function setText(session: Session, blockId: string, text: string, origin: string) {
  const doc = readDoc(session);
  const block = findBlock(doc, blockId)!;
  const content = blockContent(block);
  const state = EditorState.create({ schema: session.schema, doc });
  const tr = state.tr.insertText(text, content.from, content.to);
  writeBlock(session, tr.doc.nodeAt(block.pos)!, origin);
}

function texts(json: unknown, session: Session) {
  return blockTexts(PMNode.fromJSON(session.schema, json)).map((block) => block.text);
}

test("author pauses and AI edits become separate checkpoints that rebuild exactly", async () => {
  const { storage } = memoryHistory();
  const session = await openSession(seeded());
  const history = startHistory(session, storage, "Tighten the second paragraph");

  setText(session, "p1", "The first paragraph, revised.", "editor");
  clock += 2_000;
  setText(session, "p1", "The first paragraph, revised twice.", "editor");
  clock += 30_000; // a pause longer than the idle limit ends the checkpoint
  setText(session, "p3", "A new third paragraph.", "editor");
  clock += 1_000;
  setText(session, "p2", "A shorter second.", "ai-agent"); // the AI's edit closes the author's checkpoint
  clock += 1_000;
  await history.checkpoint();

  const entries = await history.list();
  expect(entries.map((entry) => entry.kind)).toEqual(["start", "author", "author", "ai"]);
  expect(entries[1].stats).toEqual({ added: 2, removed: 0, blocks: 1 });
  expect(entries[3].label).toBe("Tighten the second paragraph");

  const before = await history.version(entries[2].id);
  expect(texts(before!.doc, session)).toEqual(["The first paragraph, revised twice.", "The second paragraph.", "A new third paragraph."]);
  const start = await history.version(entries[0].id);
  expect(texts(start!.doc, session)).toEqual(["The first paragraph.", "The second paragraph.", "The third paragraph."]);
  const after = await history.version(entries[3].id);
  expect(texts(after!.doc, session)).toEqual(blockTexts(readDoc(session)).map((block) => block.text));
});

test("changes that leave the accepted text alone ride along with the next checkpoint", async () => {
  const { storage, chunks } = memoryHistory();
  const session = await openSession(seeded());
  const history = startHistory(session, storage);
  const learning = session.ydoc.getMap("authorEdits");

  // Bookkeeping that rewrites a large value on every keystroke must not pile up in the history.
  for (let i = 0; i < 200; i++) session.ydoc.transact(() => learning.set("k", { before: "x".repeat(2_000), after: `${i}` }), "editor");
  expect(await history.checkpoint()).toBeNull();
  setText(session, "p2", "Second, edited.", "editor");
  const entry = await history.checkpoint();
  expect(entry?.kind).toBe("author");
  expect(chunks.get(`/p/doc.scholarpen.json#${entry!.seq}`)!.length).toBeLessThan(10_000);

  const version = await history.version(entry!.id);
  expect(texts(version!.doc, session)[1]).toBe("Second, edited.");
});

test("reopening continues the same history and records changes it missed", async () => {
  const { storage, archived } = memoryHistory();
  const first = await openSession(seeded());
  const history = startHistory(first, storage);
  setText(first, "p1", "Edited before closing.", "editor");
  await history.close();
  histories.splice(histories.indexOf(history), 1);

  // An older app version edits the document without recording history.
  const state = Y.encodeStateAsUpdate(first.ydoc);
  const offline = new Y.Doc();
  Y.applyUpdate(offline, state);
  const offlineSession = { ...first, ydoc: offline } as Session;
  setText(offlineSession, "p3", "Edited while history was off.", "someone");
  const second = await openSession(Y.encodeStateAsUpdate(offline));
  const reopened = startHistory(second, storage);
  setText(second, "p2", "Edited after reopening.", "editor");
  await reopened.checkpoint();

  const entries = await reopened.list();
  expect(entries.map((entry) => entry.kind)).toEqual(["start", "author", "outside", "author"]);
  expect(archived).toHaveLength(0);
  const outside = await reopened.version(entries[2].id);
  expect(texts(outside!.doc, second)).toEqual(["Edited before closing.", "The second paragraph.", "Edited while history was off."]);
});

test("a document rebuilt from scratch starts a new history instead of mixing two", async () => {
  const { storage, archived } = memoryHistory();
  const first = await openSession(seeded());
  const history = startHistory(first, storage);
  setText(first, "p1", "Old lineage.", "editor");
  await history.close();
  histories.splice(histories.indexOf(history), 1);

  const second = await openSession(seeded()); // new client ids: the Y.Doc state was lost and reseeded
  const fresh = startHistory(second, storage);
  const entries = await fresh.list();
  expect(archived).toEqual(["/p/doc.scholarpen.json"]);
  expect(entries.map((entry) => entry.kind)).toEqual(["start"]);
});

test("naming the current version closes the open checkpoint and names it", async () => {
  const { storage } = memoryHistory();
  const session = await openSession(seeded());
  const history = startHistory(session, storage);
  setText(session, "p1", "Submitted text.", "editor");
  const named = await history.name(undefined, "  Submitted v1  ");
  expect(named?.name).toBe("Submitted v1");
  expect((await history.list()).at(-1)?.name).toBe("Submitted v1");
  await history.name(named!.id, "");
  expect((await history.list()).at(-1)?.name).toBeUndefined();
});

test("a restore checkpoint takes the kind and label it is given", async () => {
  const { storage } = memoryHistory();
  const session = await openSession(seeded());
  const history = startHistory(session, storage);
  setText(session, "p1", "Changed.", "editor");
  await history.checkpoint();
  setText(session, "p1", "The first paragraph.", "editor");
  const restored = await history.checkpoint({ kind: "restore", label: "Restored the version of 10:00" });
  expect(restored?.kind).toBe("restore");
  expect(restored?.label).toBe("Restored the version of 10:00");
});

test("old plain checkpoints thin out while AI edits keep their place", async () => {
  const { storage } = memoryHistory();
  const session = await openSession(seeded());
  const history = startHistory(session, storage);
  const day = 24 * 60 * 60_000;
  clock = new Date(2026, 0, 10, 9, 0).getTime();
  for (let i = 0; i < 3; i++) {
    clock += 60_000;
    setText(session, "p1", `Morning draft ${i}.`, "editor");
    await history.checkpoint();
  }
  clock += 60_000;
  setText(session, "p2", "AI rewrite.", "ai-agent");
  await history.checkpoint();
  clock += 60_000;
  setText(session, "p3", "After the AI.", "editor");
  await history.checkpoint();
  const beforeThinning = (await history.list()).map((entry) => entry.id);
  expect(beforeThinning).toHaveLength(6);

  clock += 5 * day; // a later checkpoint triggers thinning once an hour has passed
  setText(session, "p3", "Days later.", "editor");
  await history.checkpoint();

  const entries = await history.list();
  expect(entries.map((entry) => entry.kind)).toEqual(["start", "author", "ai", "author", "author"]);
  expect(entries[1].merged).toBe(3);
  expect(entries[1].id).toBe(beforeThinning[3]);
  const merged = await history.version(entries[1].id);
  expect(texts(merged!.doc, session)[0]).toBe("Morning draft 2.");
  const ai = await history.version(entries[2].id);
  expect(texts(ai!.doc, session)).toEqual(["Morning draft 2.", "AI rewrite.", "The third paragraph."]);
});
