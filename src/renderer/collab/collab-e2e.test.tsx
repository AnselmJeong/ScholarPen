import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Fragment, Slice } from "prosemirror-model";
import type { CollabUpdateMessage } from "../../shared/collab/protocol";

// Two mounted editors and the real Bun registry, joined by an in-process stand-in for Electrobun RPC.
const dom = new Window();
Object.defineProperty(dom.document, "compatMode", { value: "CSS1Compat" });
const globals = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "MutationObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "DocumentFragment", "DOMParser", "Text", "NodeFilter", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true,
  value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.happyDOM.abort();
});

const jsonFiles = new Map<string, unknown>([["/p/agent.scholarpen.json", [
  { id: "claim", type: "paragraph", content: "These data prove the hypothesis beyond doubt." },
]], ["/p/doc.scholarpen.json", [
  { id: "intro", type: "paragraph", content: "Original introduction." },
  { id: "eq", type: "math", props: { formula: "E = mc^2" } },
  { id: "cite", type: "paragraph", content: [
    { type: "text", text: "As shown ", styles: {} },
    { type: "citation", props: { citekey: "smith2026", locator: "p. 4" } },
  ] },
]]]);

const updateListeners = new Set<(message: CollabUpdateMessage) => void>();
const awarenessListeners = new Set<(message: CollabUpdateMessage) => void>();
const { CollabRegistry } = await import("../../bun/collab/registry");
const registry = new CollabRegistry({
  read: async () => ({ state: null, meta: null }),
  write: async () => {},
  jsonHash: async () => "external",
}, {
  // Electrobun delivers messages asynchronously.
  update: (message) => queueMicrotask(() => updateListeners.forEach((listener) => listener(message))),
  awareness: (message) => queueMicrotask(() => awarenessListeners.forEach((listener) => listener(message))),
});

mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const realRpc = { ...(await import("../rpc")) };
mock.module("../rpc", () => ({
  ...realRpc,
  rpc: {
    ...realRpc.rpc,
    collabOpen: (params: any) => registry.open(params),
    collabPush: async (docKey: string, peerId: string, update: string) => registry.push(docKey, peerId, update),
    collabAwareness: async (docKey: string, peerId: string, update: string) => registry.pushAwareness(docKey, peerId, update),
    collabClose: (docKey: string, peerId: string) => registry.close(docKey, peerId),
    loadDocument: async (projectPath: string, filename: string) => jsonFiles.get(`${projectPath}/${filename}`) ?? [],
  },
  onCollabUpdate: (listener: (message: CollabUpdateMessage) => void) => {
    updateListeners.add(listener);
    return () => updateListeners.delete(listener);
  },
  onCollabAwareness: (listener: (message: CollabUpdateMessage) => void) => {
    awarenessListeners.add(listener);
    return () => awarenessListeners.delete(listener);
  },
}));

const { BlockNoteEditor } = await import("@blocknote/core");
const { BlockNoteViewRaw } = await import("@blocknote/react");
const { scholarSchema } = await import("../blocks/schema");
const { openCollabPeer } = await import("./collab-peer");
const { reconcileBlocks } = await import("./reconcile");
const { COLLAB_FRAGMENT } = await import("../../shared/collab/protocol");
const { yXmlFragmentToProseMirrorRootNode, updateYFragment } = await import("y-prosemirror");
const { CommentsExtension } = await import("@blocknote/core/comments");
const { TextSelection } = await import("prosemirror-state");
const { resolveCollabUsers } = await import("./users");
const { setEditorCollab } = await import("./editor-collab");
const { ActivityPanel } = await import("../components/sidebar/ActivityPanel");
const { readThreads, threadWantsAI } = await import("../../shared/collab/threads");
const { AISelectionTargetExtension, suggestAISelection, trackAISelection } = await import("../components/editor/ai-selection-target");
const { protectSelectionSlice } = await import("../../shared/ai-text-protection");
const { CHANGE_SETS_MAP } = await import("../../shared/collab/change-sets");

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mountPeer(name: string, filename = "doc.scholarpen.json") {
  const peer = await openCollabPeer("/p", filename);
  const editor = BlockNoteEditor.create({
    schema: scholarSchema,
    collaboration: {
      fragment: peer.ydoc.getXmlFragment(COLLAB_FRAGMENT),
      user: { name, color: "#000" },
      provider: { awareness: peer.awareness },
    },
    extensions: [AISelectionTargetExtension(), CommentsExtension({ threadStore: peer.threadStore, resolveUsers: resolveCollabUsers })],
  });
  setEditorCollab(editor, peer);
  let changes = 0;
  editor.onChange(() => { changes++; });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<BlockNoteViewRaw editor={editor} formattingToolbar={false} linkToolbar={false} slashMenu={false}
    emojiPicker={false} sideMenu={false} filePanel={false} tableHandles={false} comments={false} />); });
  return { peer, editor, root, changes: () => changes };
}

const texts = (editor: { document: unknown[] }) =>
  editor.document.map((block: any) => (block.content ?? []).map((part: any) => part.text ?? `[${part.type}]`).join(""));

test("editors seed once, stay in sync through Bun, and see Bun-side edits", async () => {
  const a = await mountPeer("A");
  expect(a.peer.bootstrap).toBe("seed");
  await settle();
  const b = await mountPeer("B");
  expect(b.peer.bootstrap).toBe("none");
  await settle();

  // Seeded once: no duplicated blocks, custom blocks intact.
  expect(b.editor.document.map((block: any) => block.id)).toEqual(["intro", "eq", "cite", expect.any(String)]);
  expect((b.editor.document[1] as any).props.formula).toBe("E = mc^2");
  expect((b.editor.document[2] as any).content[1]).toMatchObject({ type: "citation", props: { citekey: "smith2026" } });

  // A types; B receives it.
  await act(async () => { a.editor.insertInlineContent(" Typed by A."); });
  await act(async () => { a.editor.updateBlock("intro", { content: "Edited by A." }); });
  await settle();
  expect(texts(b.editor)[0]).toBe("Edited by A.");

  // The Bun peer edits its own Y.Doc (as the AI agent will); both editors converge.
  const session = registry.get("/p::doc.scholarpen.json")!;
  const fragment = session.ydoc.getXmlFragment(COLLAB_FRAGMENT);
  const doc = yXmlFragmentToProseMirrorRootNode(fragment, session.schema);
  let paragraphPos = -1;
  doc.descendants((node, pos) => {
    if (paragraphPos < 0 && node.type.name === "paragraph" && node.textContent === "Edited by A.") paragraphPos = pos;
  });
  const edited = doc.replace(paragraphPos + 1, paragraphPos + 1 + "Edited by A.".length,
    new Slice(Fragment.from(session.schema.text("Rewritten by the AI.")), 0, 0));
  const changesBefore = b.changes();
  session.ydoc.transact(() => updateYFragment(session.ydoc, fragment, edited, { mapping: new Map(), isOMark: new Map() }), "ai");
  await settle();
  expect(texts(a.editor)[0]).toBe("Rewritten by the AI.");
  expect(texts(b.editor)[0]).toBe("Rewritten by the AI.");
  expect(b.changes()).toBeGreaterThan(changesBefore); // remote edits still trigger the JSON autosave

  // A per-block reconcile leaves untouched blocks (and their marks) alone.
  const target = JSON.parse(JSON.stringify(a.editor.document));
  target[2].content[0].text = "As reported by ";
  await act(async () => { reconcileBlocks(a.editor, target); });
  await settle();
  expect(texts(b.editor)[2]).toBe("As reported by [citation]");
  expect(texts(b.editor)[0]).toBe("Rewritten by the AI.");

  // Stage 2: a comment made in A is anchored and visible in B, and the Activity panel lists it.
  const view = a.editor.prosemirrorView!;
  let from = -1;
  view.state.doc.descendants((node, pos) => {
    if (from < 0 && node.isText && node.text?.startsWith("Rewritten")) from = pos;
  });
  await act(async () => {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + "Rewritten".length)));
    await a.editor.getExtension(CommentsExtension)!.createThread({
      initialComment: { body: [{ type: "paragraph", content: "@AI make this sentence shorter" }] },
    });
  });
  await settle();
  const threads = readThreads(b.peer.ydoc.getMap("threads"));
  expect(threads).toHaveLength(1);
  expect(threads[0].comments[0]).toMatchObject({ userId: "me", text: "@AI make this sentence shorter" });
  expect(threadWantsAI(threads[0])).toBe(true);
  expect(b.editor.getExtension(CommentsExtension)!.store.state.threadPositions.has(threads[0].id)).toBe(true);

  const panel = document.createElement("div");
  document.body.append(panel);
  const panelRoot = createRoot(panel);
  await act(async () => { panelRoot.render(<ActivityPanel editor={b.editor} documentName="doc.scholarpen.json" />); });
  expect(panel.textContent).toContain("@AI make this sentence shorter");
  expect(panel.textContent).toContain("Rewritten");
  const resolve = [...panel.querySelectorAll("button")].find((button) => button.textContent?.includes("Resolve"))!;
  await act(async () => { resolve.click(); });
  await settle();
  expect(readThreads(a.peer.ydoc.getMap("threads"))[0]).toMatchObject({ resolved: true, meta: { status: "resolved" } });
  expect(panel.textContent).toContain("No open threads");
  await act(async () => { panelRoot.unmount(); });

  await act(async () => { a.root.unmount(); b.root.unmount(); });
  a.peer.destroy();
  b.peer.destroy();
  await settle();
  expect(registry.get("/p::doc.scholarpen.json")).toBeUndefined();
});

test("a comment for the AI comes back as a suggestion the author can accept", async () => {
  const { CollabAgent } = await import("../../bun/collab/agent/agent");
  const { Reviewer } = await import("../../bun/collab/agent/reviewer");
  const { AIActivitySection } = await import("../components/sidebar/AIActivitySection");
  const { acceptedDocument } = await import("./suggestions");
  const agent = new CollabAgent(registry, {
    complete: async (messages) => {
      const passage = (messages[1].content as string).match(/<passage_to_edit>\n([\s\S]*?)\n<\/passage_to_edit>/)![1];
      return `<reply>Hedged the claim.</reply><passage>${passage.replace("prove the hypothesis beyond doubt", "support the hypothesis")}</passage>`;
    },
    onActivity: () => {},
    pollMs: 10,
    waitForAuthorMs: 200,
  });
  const a = await mountPeer("A", "agent.scholarpen.json");
  await settle();

  const view = a.editor.prosemirrorView!;
  let from = -1;
  view.state.doc.descendants((node, pos) => { if (from < 0 && node.isText) from = pos; });
  await act(async () => {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + 10)));
    await a.editor.getExtension(CommentsExtension)!.createThread({
      initialComment: { body: [{ type: "paragraph", content: "@AI too strong" }] },
    });
  });
  // The author's cursor stays in the paragraph; the AI waits briefly (waitForAuthorMs), then proceeds.

  for (let i = 0; i < 100; i++) {
    await settle();
    if (readThreads(a.peer.ydoc.getMap("threads"))[0]?.comments.length === 2) break;
  }
  const thread = readThreads(a.peer.ydoc.getMap("threads"))[0];
  expect(thread.comments[1].text).toContain("Hedged the claim.");
  expect(thread.meta.status).toBe("proposed");
  // The editor shows a tracked change; the saved snapshot still holds the accepted text.
  expect(view.dom.querySelector("ins")?.textContent).toContain("support");
  expect(view.dom.querySelector("del")?.textContent).toContain("prove");
  expect(JSON.stringify(acceptedDocument(a.editor))).toContain("These data prove the hypothesis beyond doubt.");

  // A reload from the saved JSON (accepted text only) must keep pending suggestions.
  await act(async () => { reconcileBlocks(a.editor, JSON.parse(JSON.stringify(acceptedDocument(a.editor)))); });
  await settle();
  expect(view.dom.querySelector("ins")?.textContent).toContain("support");

  const panel = document.createElement("div");
  document.body.append(panel);
  const panelRoot = createRoot(panel);
  await act(async () => { panelRoot.render(<AIActivitySection editor={a.editor} />); });
  expect(panel.textContent).toContain("1 AI change to review");
  expect(panel.textContent).toContain("1 paragraph");
  const accept = [...panel.querySelectorAll("button")].find((button) => button.textContent === "Accept")!;
  await act(async () => { accept.click(); });
  await settle();
  // Accepting the change set closes the loop on the thread that asked for it.
  expect(readThreads(a.peer.ydoc.getMap("threads"))[0]).toMatchObject({ resolved: true, meta: { status: "resolved" } });
  expect(panel.textContent).not.toContain("AI change to review");
  expect(view.dom.querySelector("ins")).toBeNull();
  expect(JSON.stringify(acceptedDocument(a.editor))).toContain("These data support the hypothesis.");
  // Accepting syncs back to Bun like any other edit.
  const bunDoc = (await import("../../bun/collab/agent/doc-model")).readDoc(registry.get("/p::agent.scholarpen.json")!);
  expect(bunDoc.textContent).toContain("These data support the hypothesis.");

  // A real Accept click resolves an author-created thread with no review blockId.
  // Its AI-rewritten paragraph must not immediately start another automatic review.
  let reviewCalls = 0;
  const reviewer = new Reviewer(agent, {
    complete: async () => { reviewCalls++; return '{"findings":[]}'; },
    citekeys: async () => null,
    tickMs: 0,
  });
  await act(async () => { reviewer.tick(); });
  await settle();
  expect(reviewCalls).toBe(0);
  expect(registry.get("/p::agent.scholarpen.json")!.ydoc.getMap("review").get("progress"))
    .toEqual({ reviewedSections: 1, totalSections: 1 });
  reviewer.dispose();

  await act(async () => { panelRoot.unmount(); a.root.unmount(); });
  agent.dispose();
  a.peer.destroy();
  await settle();
});

test("selection suggestions sync metadata and support per-paragraph Accept/Reject in the existing activity panel", async () => {
  jsonFiles.set("/p/selection.scholarpen.json", [
    { id: "one", type: "paragraph", content: "A strong claim." },
    { id: "two", type: "paragraph", content: "Another strong claim." },
  ]);
  const a = await mountPeer("A", "selection.scholarpen.json");
  const b = await mountPeer("B", "selection.scholarpen.json");
  await settle();
  const { AIActivitySection } = await import("../components/sidebar/AIActivitySection");
  const { acceptedDocument, listChangeSets } = await import("./suggestions");
  const view = a.editor.prosemirrorView;
  let from = -1, to = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.isText) { if (from < 0) from = pos; to = pos + node.nodeSize; }
  });
  const protection = protectSelectionSlice(view.state.doc.slice(from, to), "A strong claim. Another strong claim.");
  await act(async () => {
    trackAISelection(view, from, to, protection);
    expect(suggestAISelection(a.editor, protection, protection.protectedText.replaceAll("strong", "qualified"), "Deepen")).toBeNull();
  });
  await settle();
  const sets = listChangeSets(b.editor.prosemirrorView.state.doc, b.peer.ydoc.getMap(CHANGE_SETS_MAP));
  expect(sets).toHaveLength(1);
  expect(sets[0].info?.label).toBe("Deepen");
  expect(JSON.stringify(acceptedDocument(b.editor))).not.toContain("qualified");
  expect(b.editor.prosemirrorView.dom.querySelector("ins")?.textContent).toBe("qualified");
  const panel = document.createElement("div");
  document.body.append(panel);
  const panelRoot = createRoot(panel);
  try {
    await act(async () => { panelRoot.render(<AIActivitySection editor={b.editor} />); });
    expect(panel.textContent).toContain("Deepen");
    await act(async () => { (panel.querySelector('[aria-label="Review paragraph by paragraph"]') as HTMLButtonElement).click(); });
    await act(async () => { (panel.querySelector('[aria-label="Accept this paragraph"]') as HTMLButtonElement).click(); });
    await settle();
    expect(texts(a.editor)[0]).toBe("A qualified claim.");
    expect(listChangeSets(a.editor.prosemirrorView.state.doc)[0].paragraphs).toHaveLength(1);
    await act(async () => { (panel.querySelector('[aria-label="Reject this paragraph"]') as HTMLButtonElement).click(); });
    await settle();
    expect(texts(a.editor)[1]).toBe("Another strong claim.");
    expect(listChangeSets(a.editor.prosemirrorView.state.doc)).toHaveLength(0);
    expect(a.peer.ydoc.getMap(CHANGE_SETS_MAP).size).toBe(0);
  } finally {
    await act(async () => { panelRoot.unmount(); a.root.unmount(); b.root.unmount(); });
    panel.remove(); a.peer.destroy(); b.peer.destroy();
    await settle();
  }
});
