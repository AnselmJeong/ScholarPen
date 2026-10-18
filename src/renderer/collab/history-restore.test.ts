import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

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

const { scholarSchema } = await import("../blocks/schema");
const { BlockNoteEditor } = await import("@blocknote/core");
const { currentTexts, readVersion, restoreBlock, restoreDocument } = await import("./history-restore");
const editor = BlockNoteEditor.create({ schema: scholarSchema });

const paragraph = (id: string, text: string) => ({ id, type: "paragraph", content: text });

function load(blocks: unknown[]) {
  editor.replaceBlocks(editor.document, blocks as any);
}

/** Captures a version the way Bun sends it: the document's ProseMirror JSON. */
function snapshot() {
  return readVersion(editor, editor.prosemirrorState.doc.toJSON());
}

function texts() {
  return currentTexts(editor).map((block) => `${block.id}:${block.text}`);
}

test("a version read from ProseMirror JSON matches the editor's blocks", () => {
  load([paragraph("a", "Alpha."), { id: "h", type: "heading", props: { level: 2 }, content: "Methods" }]);
  const version = snapshot();
  expect(JSON.stringify(version.blocks)).toBe(JSON.stringify(editor.document));
  expect(version.texts.map((block) => block.type)).toEqual(["paragraph", "heading"]);
});

test("restoring a version replaces only the blocks that differ", () => {
  load([paragraph("a", "Alpha old."), paragraph("b", "Beta."), paragraph("c", "Gamma.")]);
  const version = snapshot();
  load([paragraph("a", "Alpha new."), paragraph("b", "Beta."), paragraph("d", "Delta.")]);
  const untouched = editor.prosemirrorState.doc.child(0).child(1);

  expect(restoreDocument(editor, version.blocks)).toBe(true);
  expect(texts()).toEqual(["a:Alpha old.", "b:Beta.", "c:Gamma."]);
  // The unchanged paragraph is the same node, so its marks and comments are kept.
  expect(editor.prosemirrorState.doc.child(0).child(1)).toBe(untouched);
  expect(restoreDocument(editor, version.blocks)).toBe(false);
});

test("restoring a version undoes moved and inserted-before blocks", () => {
  load([paragraph("a", "One."), paragraph("b", "Two."), paragraph("c", "Three.")]);
  const version = snapshot();
  load([paragraph("x", "New first."), paragraph("c", "Three."), paragraph("a", "One."), paragraph("b", "Two.")]);
  restoreDocument(editor, version.blocks);
  expect(texts()).toEqual(["a:One.", "b:Two.", "c:Three."]);
});

test("a deleted paragraph comes back after its old neighbour, a changed one gets its old text", () => {
  load([paragraph("a", "One."), paragraph("b", "Two, as written."), paragraph("c", "Three.")]);
  const version = snapshot();
  load([paragraph("a", "One."), paragraph("c", "Three, edited.")]);

  expect(restoreBlock(editor, version.blocks, "b")).toBe(true);
  expect(texts()).toEqual(["a:One.", "b:Two, as written.", "c:Three, edited."]);
  expect(restoreBlock(editor, version.blocks, "c")).toBe(true);
  expect(texts()).toEqual(["a:One.", "b:Two, as written.", "c:Three."]);
  expect(restoreBlock(editor, version.blocks, "missing")).toBe(false);
});
