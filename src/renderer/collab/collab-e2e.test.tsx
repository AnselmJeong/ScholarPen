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
const commentExports: Array<{ projectPath: string; filename: string; content: string }> = [];
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
    exportFile: async (projectPath: string, filename: string, content: string) => {
      commentExports.push({ projectPath, filename, content });
      return `${projectPath}/exports/${filename}`;
    },
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
const { requestAIScoreManuscript, requestHumanizeManuscript, requestRemoveWatermarkManuscript } = await import("./comment-composer");
const { getScholarSlashMenuItems } = await import("../blocks/slash-menu-items");

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

test("independent slash actions target the current document despite a partial selection; cleanup is local and undoable", async () => {
  const { CollabAgent } = await import("../../bun/collab/agent/agent");
  jsonFiles.set("/p/watermark.scholarpen.json", [
    { id: "first", type: "paragraph", content: "First\u200B passage.", children: [{ id: "nested", type: "paragraph", content: "Nested\u200B prose." }] },
    { id: "last", type: "paragraph", content: [
      { type: "text", text: "Last\u00A0passage ", styles: { bold: true } },
      { type: "citation", props: { citekey: "smith2026", locator: "p. 4" } },
      { type: "text", text: " A\u200BB 👨‍👩‍👧", styles: {} },
      { type: "text", text: " inline\u200Bcode", styles: { code: true } },
      { type: "text", text: " $a\u200Bb$", styles: {} },
    ] },
  ]);
  (jsonFiles.get("/p/watermark.scholarpen.json") as unknown[]).push(
    { id: "code", type: "codeBlock", content: "code\u200Btext" },
    { id: "title", type: "heading", content: "Heading\u00A0text" },
  );
  jsonFiles.set("/p/untouched.scholarpen.json", [{ id: "other", type: "paragraph", content: "Other\u200B document." }]);
  const a = await mountPeer("A", "watermark.scholarpen.json");
  const b = await mountPeer("B", "untouched.scholarpen.json");
  const original = texts(a.editor);
  const agent = new CollabAgent(registry, {
    complete: async () => { throw new Error("Watermark cleanup must not call the model"); },
    onActivity: () => {}, pollMs: 5,
  });
  const resultHost = document.createElement("div");
  document.body.append(resultHost);
  const resultRoot = createRoot(resultHost);
  try {
  const items = getScholarSlashMenuItems(a.editor, () => {}, () => {},
    () => requestHumanizeManuscript(a.editor), () => requestRemoveWatermarkManuscript(a.editor), () => requestAIScoreManuscript(a.editor));
  const view = a.editor.prosemirrorView!;
  let textStart = 0;
  view.state.doc.descendants((node, pos) => { if (!textStart && node.isText) textStart = pos; });
  await act(async () => {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textStart, textStart + 2)));
    items.find(item => item.title === "Remove watermark")!.onItemClick();
  });
  for (let i = 0; i < 100; i++) {
    await settle();
    if (readThreads(a.peer.ydoc.getMap("threads"))[0]?.resolved) break;
  }
  expect(texts(a.editor).filter(Boolean)).toEqual(["First passage.", "Last passage [citation] AB 👨‍👩‍👧 inline\u200Bcode $a\u200Bb$", "code\u200Btext", "Heading text"]);
  expect(a.editor.getBlock("nested")!.content).toContainEqual({ type: "text", text: "Nested prose.", styles: {} });
  expect(texts(b.editor).filter(Boolean)).toEqual(["Other\u200B document."]);
  expect(a.editor.getBlock("last")!.content).toContainEqual({ type: "text", text: "Last passage ", styles: { bold: true } });
  expect(readThreads(a.peer.ydoc.getMap("threads"))[0].meta).toMatchObject({ scope: "document", documentAction: "remove-watermark" });
  expect(readThreads(a.peer.ydoc.getMap("threads"))[0].meta.watermarkResult).toMatchObject({ removed: 3, replaced: 2, skipped: 1 });
  await act(async () => { resultRoot.render(<ActivityPanel editor={a.editor} documentName="watermark.scholarpen.json" projectPath="/p" />); });
  await settle();
  expect(resultHost.querySelector('[aria-label="Remove watermark result"]')?.textContent).toContain("숨은 문자 3개 제거 · 특수 공백 2개 정리");
  // The in-memory activity RPC is empty: a resolved cleanup still has a visible,
  // durable result, independent of the default Open comment filter.
  expect(resultHost.textContent).toContain("1개 블록 제외");
  const cleaned = texts(a.editor);
  await act(async () => { requestRemoveWatermarkManuscript(a.editor); });
  for (let i = 0; i < 100; i++) {
    await settle();
    if (readThreads(a.peer.ydoc.getMap("threads")).filter(thread => thread.resolved).length === 2) break;
  }
  expect(texts(a.editor)).toEqual(cleaned);
  expect(resultHost.querySelector('[aria-label="Remove watermark result"]')?.textContent).toContain("검사한 텍스트에서 정리할 문자가 없었습니다");
  await act(async () => { resultRoot.render(<></>); });
  await act(async () => { resultRoot.render(<ActivityPanel editor={a.editor} documentName="watermark.scholarpen.json" projectPath="/p" />); });
  await settle();
  expect(resultHost.querySelector('[aria-label="Remove watermark result"]')).not.toBeNull();
  await act(async () => { resultHost.querySelector<HTMLButtonElement>('[aria-label="워터마크 정리 결과 닫기"]')!.click(); });
  await settle();
  expect(resultHost.querySelector('[aria-label="Remove watermark result"]')).toBeNull();
  await act(async () => { resultRoot.render(<></>); });
  await act(async () => { resultRoot.render(<ActivityPanel editor={a.editor} documentName="watermark.scholarpen.json" projectPath="/p" />); });
  await settle();
  expect(resultHost.querySelector('[aria-label="Remove watermark result"]')).toBeNull();
  await act(async () => { expect(agent.undoLast(a.peer.docKey)).toBe(true); });
  await settle();
  expect(texts(a.editor).filter(Boolean)).toEqual(original.filter(Boolean));
  expect(a.editor.getBlock("nested")!.content).toContainEqual({ type: "text", text: "Nested\u200B prose.", styles: {} });

  agent.setPaused(true);
  await act(async () => {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textStart, textStart + 2)));
    items.find(item => item.title === "Humanize")!.onItemClick();
  });
  await settle();
  expect(readThreads(a.peer.ydoc.getMap("threads")).find(thread => thread.meta.documentAction === "humanize")?.meta.scope).toBe("document");
  expect(view.state.selection.from).toBe(textStart);
  expect(view.state.selection.to).toBe(textStart + 2);
  const beforeDetection = view.state.doc.toJSON();
  await act(async () => { items.find(item => item.title === "AI writing score")!.onItemClick(); });
  await settle();
  expect(readThreads(a.peer.ydoc.getMap("threads")).find(thread => thread.meta.documentAction === "ai-score")?.meta.scope).toBe("document");
  expect(view.state.doc.toJSON()).toEqual(beforeDetection);
  expect(view.state.doc.textContent).toBe(a.editor.prosemirrorState.doc.textContent);
  } finally {
  agent.dispose();
  await act(async () => resultRoot.unmount());
  resultHost.remove();
  await act(async () => { a.root.unmount(); b.root.unmount(); });
  a.peer.destroy(); b.peer.destroy();
  await settle();
  }
});

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
  await act(async () => { panelRoot.render(<ActivityPanel editor={b.editor} documentName="doc.scholarpen.json" projectPath="/p" />); });
  expect(panel.textContent).toContain("@AI make this sentence shorter");
  expect(panel.textContent).toContain("Rewritten");
  // Export reads live shared state and does not resolve the comments.
  const exportButton = [...panel.querySelectorAll("button")].find(button => button.textContent?.includes("Export unresolved"))!;
  await act(async () => { exportButton.click(); });
  await settle();
  expect(commentExports.at(-1)?.projectPath).toBe("/p");
  expect(commentExports.at(-1)?.filename).toMatch(/^doc-unresolved-comments-.*\.md$/);
  expect(commentExports.at(-1)?.content).toContain("@AI make this sentence shorter");
  expect(commentExports.at(-1)?.content).toContain("Rewritten");
  expect(readThreads(a.peer.ydoc.getMap("threads"))[0].resolved).toBe(false);
  expect(panel.querySelector('[role="status"]')?.textContent).toContain("1개 코멘트 저장됨");
  const resolve = [...panel.querySelectorAll("button")].find((button) => button.textContent?.includes("Resolve"))!;
  await act(async () => { resolve.click(); });
  await settle();
  expect(readThreads(a.peer.ydoc.getMap("threads"))[0]).toMatchObject({ resolved: true, meta: { status: "resolved" } });
  expect(panel.textContent).toContain("No open threads");
  expect(exportButton.disabled).toBe(true);
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

for (const accept of [true, false]) {
  test(`bulk comment buttons coordinate both authors and ${accept ? "accept" : "reject"} the whole revision`, async () => {
    const { CollabAgent } = await import("../../bun/collab/agent/agent");
    const { createThread, updateThreadMeta, AI_USER_ID } = await import("../../shared/collab/threads");
    const { listChangeSets } = await import("./suggestions");
    const filename = `bulk-${accept}.scholarpen.json`;
    jsonFiles.set(`/p/${filename}`, [
      { id: "first", type: "paragraph", content: "The data prove our hypothesis." },
      { id: "last", type: "paragraph", content: "The findings prove our hypothesis." },
    ]);
    const a = await mountPeer("A", filename);
    await settle();
    let calls = 0;
    const agent = new CollabAgent(registry, {
      onActivity: () => {},
      complete: async messages => {
        calls++;
        const payload = JSON.parse(String(messages[1].content));
        if (payload.candidateManuscript) return JSON.stringify({ consistent: true, outcomes: payload.proposedOutcomes });
        expect(payload.authorInstructions).toEqual(["Keep my terminology."]);
        expect(payload.comments.filter((comment: { target: boolean }) => comment.target)).toHaveLength(3);
        return JSON.stringify({ summary: "Qualify both ends of the document.",
          edits: payload.editable_segments.filter((segment: { text: string }) => segment.text.includes("prove")).map((segment: { id: string; text: string }) => ({ id: segment.id, text: segment.text.replace("prove", "suggest") })),
          outcomes: payload.comments.filter((comment: { target: boolean }) => comment.target).map((comment: { id: string; comments: Array<{ text: string }> }) => ({
            threadId: comment.id, status: comment.comments[0].text.includes("Choose") ? "needs-user" : "addressed",
            reason: "Checked against the whole manuscript.", blockIds: comment.comments[0].text.includes("Choose") ? [] : ["first", "last"],
          })),
        });
      },
    });
    const panel = document.createElement("div"); document.body.append(panel);
    const panelRoot = createRoot(panel);
    const map = a.peer.ydoc.getMap("threads");
    let ai = "", human = "", decision = "";
    try {
      await act(async () => {
        ai = createThread(map, AI_USER_ID, "Qualify the introduction.", { assignee: "me", blockId: "first" });
        human = createThread(map, "me", "Keep the conclusion consistent.", { manual: true, blockId: "last" });
        decision = createThread(map, "me", "Choose a primary endpoint.", { manual: true, blockId: "last" });
        panelRoot.render(<ActivityPanel editor={a.editor} documentName={filename} projectPath="/p" />);
      });
      await settle();
      const group = panel.querySelector('[aria-label="All open comments"]')!;
      const exportButton = Array.from(panel.querySelectorAll("button")).find(button => button.textContent?.includes("Export unresolved"))!;
      expect(exportButton.nextElementSibling).toBe(group);
      // The AI filter must not exclude author comments from the bulk action.
      await act(async () => { Array.from(panel.querySelectorAll("button")).find(button => button.textContent === "AI 1")!.click(); });
      const input = panel.querySelector<HTMLInputElement>('[aria-label="Instructions for all comments"]')!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, "Keep my terminology.");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => { Array.from(group.querySelectorAll("button")).find(button => button.textContent?.includes("Ask AI"))!.click(); });
      for (let i = 0; i < 100 && !listChangeSets(a.editor.prosemirrorState.doc).length; i++) {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
      }
      await settle();
      expect(agent.jobs(a.peer.docKey).find(job => job.state === "failed")?.detail).toBeUndefined();
      expect(calls).toBe(2);
      expect(listChangeSets(a.editor.prosemirrorState.doc)).toHaveLength(1);
      expect(readThreads(map).find(thread => thread.id === human)?.meta.status).toBe("proposed");
      const label = accept ? "Accept coordinated revision" : "Reject coordinated revision";
      const decisionButton = Array.from(panel.querySelectorAll("button")).find(button => button.textContent?.includes(label));
      expect(decisionButton).toBeDefined();
      await act(async () => { decisionButton!.click(); });
      await settle();
      expect(listChangeSets(a.editor.prosemirrorState.doc)).toHaveLength(0);
      expect(readThreads(map).find(thread => thread.id === ai)?.resolved).toBe(accept);
      expect(readThreads(map).find(thread => thread.id === human)?.resolved).toBe(accept);
      expect(readThreads(map).find(thread => thread.id === decision)?.resolved).toBe(false);
      expect(texts(a.editor).filter(Boolean)).toEqual(accept
        ? ["The data suggest our hypothesis.", "The findings suggest our hypothesis."]
        : ["The data prove our hypothesis.", "The findings prove our hypothesis."]);
      const beforeDismiss = a.editor.prosemirrorState.doc.toJSON();
      await act(async () => { Array.from(group.querySelectorAll("button")).find(button => button.textContent?.includes("Resolve all"))!.click(); });
      await settle();
      expect(readThreads(map).every(thread => thread.resolved)).toBe(true);
      expect(a.editor.prosemirrorState.doc.toJSON()).toEqual(beforeDismiss);
      // Dismissal is reversible through the ordinary per-thread action.
      await act(async () => { updateThreadMeta(map, decision, { status: "open" }); });
      expect(readThreads(map).find(thread => thread.id === decision)?.resolved).toBe(false);
    } finally {
      agent.dispose();
      await act(async () => { panelRoot.unmount(); a.root.unmount(); });
      panel.remove(); a.peer.destroy(); await settle();
    }
  });
}
