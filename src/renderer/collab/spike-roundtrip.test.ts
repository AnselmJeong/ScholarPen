import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import * as Y from "yjs";

// Stage 1 spike: every real manuscript must survive BlockNote JSON → Y.Doc → BlockNote JSON.
// Point SCHOLARPEN_SPIKE_DIR at a projects root to run it against real documents.
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
const { blocksToYDoc, yDocToBlocks } = await import("@blocknote/core/yjs");
const { normalizeQuartoBlocks } = await import("../../shared/quarto-references");
const editor = BlockNoteEditor.create({ schema: scholarSchema });

function findDocuments(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const path = join(root, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) findDocuments(path, out);
    else if (entry.endsWith(".scholarpen.json")) out.push(path);
  }
  return out;
}

const root = process.env.SCHOLARPEN_SPIKE_DIR;
test.skipIf(!root)("real manuscripts round-trip through Y.Doc unchanged", () => {
  const failures: string[] = [];
  const documents = findDocuments(root!);
  for (const path of documents) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const blocks = normalizeQuartoBlocks(raw);
    // Baseline: the editor's own normalization of the stored JSON.
    const baseline = JSON.stringify(editor.document.length >= 0 && (() => {
      editor.replaceBlocks(editor.document, blocks as any);
      return editor.document;
    })());
    const ydoc = blocksToYDoc(editor, blocks as any, "document-store");
    // Ship the state through a binary update, as the RPC provider will.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    const roundTripped = JSON.stringify(yDocToBlocks(editor, peer, "document-store"));
    if (roundTripped !== baseline) {
      let at = 0;
      while (at < baseline.length && baseline[at] === roundTripped[at]) at++;
      failures.push(`${path}\n  expected …${baseline.slice(Math.max(0, at - 120), at + 120)}\n  actual   …${roundTripped.slice(Math.max(0, at - 120), at + 120)}`);
    }
  }
  console.log(`[spike] checked ${documents.length} documents, ${failures.length} mismatches`);
  expect(failures).toEqual([]);
}, 600_000);
