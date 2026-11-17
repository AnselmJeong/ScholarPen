import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

// The webview's real schema builds the live letter; Bun then reads and writes its copy.
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

const { mkdtemp, mkdir, readFile, realpath, rm, writeFile } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const Y = await import("yjs");
const { getHeadlessEditor } = await import("../../renderer/collab/collab-peer");
const { blocksToYDoc } = await import("@blocknote/core/yjs");
const { CollabRegistry } = await import("../collab/registry");
const { schemaToSpecJSON } = await import("../../shared/collab/schema-spec");
const letter = await import("../../shared/review-session/letter-document");
const { ensureLetterDocument, overlayLetterDocument, readLetterBlocks, readLetterRecord, writeLetterResponses } = await import("./letter-document");
const { fileSystem } = await import("../fs/manager");

const editor = getHeadlessEditor();
const schemaSpec = schemaToSpecJSON(editor.pmSchema);

const session = {
  id: "2026-11-17-peer-0a1b2c3d-1111-2222-3333-444455556666",
  input: { mode: "peer", language: "English" },
  comments: [
    { id: "R1.1", reviewerId: "R1", original: "The sample is small.\n\nPlease justify it." },
    { id: "R1.2", reviewerId: "R1", original: "Define tDCS at first use." },
  ],
} as any;
const responses = [
  { commentId: "R1.1", disposition: "changed", response: "We agree.\n\nWe added a power analysis:\n- alpha 0.05\n- power 0.8", changeIds: [], locations: [], verification: "verified" },
  { commentId: "R1.2", disposition: "changed", response: "Defined in the Introduction.", changeIds: [], locations: [], verification: "verified" },
] as any[];
const ids = ["R1.1", "R1.2"];

let registry: InstanceType<typeof CollabRegistry> | null = null;
let root = "";
afterEach(async () => {
  await registry?.dispose();
  registry = null;
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

async function project() {
  root = await realpath(await mkdtemp(join(tmpdir(), "scholar-letter-")));
  await mkdir(join(root, "documents"));
  await mkdir(join(root, "letter"));
  await fileSystem.openProjectByPath(root);
  return { project: root, folder: join(root, "letter") };
}

test("the letter document reads back every response as written, lists included", () => {
  const blocks = letter.letterDocumentBlocks(session, responses);
  expect(blocks.filter((block) => block.type === "quote")).toHaveLength(3);
  const read = letter.letterResponses(letter.letterBlocksFromJSON(blocks), ids);
  expect(read.get("R1.1")).toBe("We agree.\n\nWe added a power analysis:\n\n- alpha 0.05\n- power 0.8");
  expect(read.get("R1.2")).toBe("Defined in the Introduction.");
  // Without its "Response" heading a section is not guessed at.
  const headless = letter.letterBlocksFromJSON(blocks).filter((block) => block.id !== letter.responseHeadingId("R1.2"));
  expect(letter.letterResponses(headless, ids).has("R1.2")).toBe(false);
  expect(letter.isLetterDocument(letter.letterDocumentFilename(session.id))).toBe(true);
  expect(letter.letterDocumentFilename(session.id)).toBe("response-letters/response-2026-11-17-0a1b2c3d.scholarpen.json");
});

test("a closed letter: the author's wording wins, and a rewrite leaves the sections they changed", async () => {
  const { project: path, folder } = await project();
  const made = await ensureLetterDocument(path, folder, session, responses);
  expect(made).toEqual({ filename: letter.letterDocumentFilename(session.id), created: true });
  expect((await ensureLetterDocument(path, folder, session, responses)).created).toBe(false);
  // The document's own paragraph layout is not an edit.
  expect((await overlayLetterDocument(path, folder, session, responses)).map((item) => item.response)).toEqual(responses.map((item) => item.response));

  // The author rewrites R1.2 in the document.
  const file = join(path, "documents", made.filename);
  const json = JSON.parse(await readFile(file, "utf8"));
  const paragraph = json.find((block: any) => block.id === "letter-R1.2-p0");
  paragraph.content = [{ type: "text", text: "We now define tDCS in the first sentence of the Introduction.", styles: {} }];
  await writeFile(file, JSON.stringify(json));
  const overlaid = await overlayLetterDocument(path, folder, session, responses);
  expect(overlaid[1].response).toBe("We now define tDCS in the first sentence of the Introduction.");
  expect(overlaid[0]).toBe(responses[0]);

  const result = await writeLetterResponses(path, folder, session, new Map([["R1.1", "We agree and added a power analysis."], ["R1.2", "Rewritten by the AI."]]));
  expect(result).toEqual({ updated: ["R1.1"], kept: ["R1.2"] });
  const after = letter.letterResponses((await readLetterBlocks(path, made.filename))!, ids);
  expect(after.get("R1.1")).toBe("We agree and added a power analysis.");
  expect(after.get("R1.2")).toBe("We now define tDCS in the first sentence of the Introduction.");
  expect((await readLetterRecord(folder))!.written["R1.1"]).toBe("We agree and added a power analysis.");
});

test("an open letter is rewritten in the shared document, as an AI edit", async () => {
  const { project: path, folder } = await project();
  const made = await ensureLetterDocument(path, folder, session, responses);
  const blocks = JSON.parse(await readFile(join(path, "documents", made.filename), "utf8"));
  const seeded = blocksToYDoc(editor, blocks, "document-store");
  registry = new CollabRegistry({
    read: async () => ({ state: Y.encodeStateAsUpdate(seeded), meta: { jsonHash: "h", updatedAt: 0 } }),
    write: async () => {},
    jsonHash: async () => "h",
  }, { update: () => {}, awareness: () => {} });
  await registry.open({ projectPath: path, filename: made.filename, peerId: "editor", schema: schemaSpec });
  const live = registry.get(`${path}::${made.filename}`)!;
  const sources = {
    openSession: async () => live,
    storedState: async () => null,
    documentJSON: async () => { throw new Error("the open document is read live"); },
  };
  const origins: unknown[] = [];
  live.ydoc.on("afterTransaction", (transaction) => { origins.push(transaction.origin); });
  const result = await writeLetterResponses(path, folder, session, new Map([["R1.1", "Shorter answer.\n\nSecond paragraph."]]), sources as any);
  expect(result).toEqual({ updated: ["R1.1"], kept: [] });
  const read = letter.letterResponses((await readLetterBlocks(path, made.filename, sources as any))!, ids);
  expect(read.get("R1.1")).toBe("Shorter answer.\n\nSecond paragraph.");
  expect(read.get("R1.2")).toBe("Defined in the Introduction.");
  expect(origins).toContain("ai-agent");
  expect([...live.ydoc.getMap("aiEdits").keys()]).toHaveLength(2);
});
