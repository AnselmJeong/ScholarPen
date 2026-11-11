import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
const dom = new Window();
Object.defineProperty(dom.document, "compatMode", { value: "CSS1Compat" });
const keys = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "MutationObserver", "ResizeObserver", "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "DocumentFragment", "DOMParser", "Text", "NodeFilter", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
let paneWidth = 1100;
Object.defineProperty(dom.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => paneWidth });
const resizeListeners = new Set<() => void>();
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class {
  private targets = new Set<Element>();
  private notify: () => void;
  constructor(callback: () => void) { this.notify = () => { if ([...this.targets].some(el => el.hasAttribute("data-test-scroll"))) callback(); }; resizeListeners.add(this.notify); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { resizeListeners.delete(this.notify); }
} });
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const { BlockNoteEditor } = await import("@blocknote/core");
// BlockNote's real Thread owns an internal reply editor. This stateful stand-in
// checks its lifetime without mounting Mantine's browser-only focus machinery.
mock.module("../../collab/comment-composer", () => ({ ScholarFloatingThread: function Draft() {
  const [value, setValue] = useState("");
  return <div className="bn-comment-editor"><textarea value={value} onInput={event => setValue(event.currentTarget.value)} /></div>;
} }));
const { BlockNoteViewRaw: BlockNoteView } = await import("@blocknote/react");
const { CommentsExtension, DefaultThreadStoreAuth, YjsThreadStore } = await import("@blocknote/core/comments");
const { ReviewMargin } = await import("./ReviewMargin");
const { SuggestionReviewBar } = await import("./SuggestionReviewBar");
const { createReviewStore, SuggestionReviewExtension } = await import("../../collab/suggestion-review");
const { createThread, readThreads, updateThreadMeta } = await import("../../../shared/collab/threads");
const { COLLAB_THREADS_MAP } = await import("../../../shared/collab/protocol");
const { listHunks } = await import("../../collab/suggestion-hunks");

async function settle() { for (let i = 0; i < 3; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }

test("margin cards follow live anchors, decide only one hunk, and retire resolved comments", async () => {
  const ydoc = new Y.Doc();
  const threads = ydoc.getMap(COLLAB_THREADS_MAP);
  const threadStore = new YjsThreadStore("me", threads, new DefaultThreadStoreAuth("me", "editor"));
  const store = createReviewStore();
  const editor = BlockNoteEditor.create({
    initialContent: [{ id: "intro", type: "paragraph", content: "First old claim. Second old claim. Comment target." }],
    extensions: [CommentsExtension({ threadStore, resolveUsers: async () => [] }), SuggestionReviewExtension({ store })],
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  function Fixture() {
    const canvas = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null);
    const [p, setP] = useState({ count: 0, wide: false });
    const [visible, setVisible] = useState(true);
    return <div data-test-scroll ref={scroll}><button aria-label="Toggle notes" onClick={() => setVisible(value => !value)}>Notes</button><div ref={canvas} data-count={p.count} data-margin-layout={p.wide ? "wide" : "compact"}>
      <BlockNoteView editor={editor} comments={false} formattingToolbar={false} slashMenu={false} sideMenu={false}>
        <ReviewMargin editor={editor} peer={{ ydoc, threadStore } as any} store={store} canvasRef={canvas} scrollRef={scroll} visible={visible} onPresentationChange={setP} />
      </BlockNoteView>
      <SuggestionReviewBar editor={editor} store={store} scrollContainer={scroll.current} showPopover={!p.wide} />
    </div></div>;
  }
  try {
    await act(async () => { root.render(<Fixture />); });
    const range = (text: string) => {
      let found = { from: -1, to: -1 };
      editor.prosemirrorView.state.doc.descendants((node, pos) => { if (node.isText && node.text?.includes(text)) found = { from: pos + node.text.indexOf(text), to: pos + node.text.indexOf(text) + text.length }; });
      return found;
    };
    let noteId = "";
    await act(async () => {
      noteId = createThread(threads, "me", "Explain this term.", { manual: true });
      const r = range("Comment target.");
      editor.prosemirrorView.dispatch(editor.prosemirrorView.state.tr.addMark(r.from, r.to, editor.pmSchema.marks.comment.create({ threadId: noteId })));
      // Two separate hunks in the same request AND the same paragraph.
      for (const [before, after] of [["First old claim.", "First revised claim."], ["Second old claim.", "Second revised claim."]]) {
        const at = range(before);
        editor.prosemirrorView.dispatch(editor.prosemirrorView.state.tr.addMark(at.from, at.to, editor.pmSchema.marks.deletion.create({ id: 9 }))
          .insert(at.to, editor.pmSchema.text(after, [editor.pmSchema.marks.insertion.create({ id: 9 })])));
      }
    });
    await settle();
    expect(container.querySelectorAll(".sp-margin-card")).toHaveLength(3);
    expect(container.textContent).toContain("Explain this term.");
    // A dense margin can push a card below its source. Wide navigation must
    // reveal that card without a competing smooth scroll back to the text.
    const scrolls: string[] = [];
    const card = container.querySelector<HTMLElement>('.sp-margin-card[aria-label="Edit 1"]')!;
    card.getBoundingClientRect = () => new dom.DOMRect(800, 900, 248, 140) as DOMRect;
    card.scrollIntoView = () => { scrolls.push("card"); };
    const source = editor.prosemirrorView.domAtPos(store.hunks[0].insertions[0].from).node;
    const sourceElement = (source instanceof Element ? source : source.parentElement)!;
    sourceElement.scrollIntoView = () => { scrolls.push("source"); };
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Next change"]')!.click(); });
    await settle();
    expect(scrolls).toEqual(["card"]);
    await act(async () => { card.querySelector<HTMLButtonElement>('[aria-label="Edit 1: show in text"]')!.click(); });
    await settle();
    expect(scrolls).toEqual(["card", "source"]);
    const before = editor.getExtension(CommentsExtension)!.store.state.threadPositions.get(noteId)!.from;
    await act(async () => { editor.prosemirrorView.dispatch(editor.prosemirrorView.state.tr.insertText("Prefix. ", 3)); });
    await settle();
    expect(editor.getExtension(CommentsExtension)!.store.state.threadPositions.get(noteId)!.from).toBe(before + 8);
    expect(container.querySelectorAll(".sp-margin-card")).toHaveLength(3);
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Accept edit 1"]')!.click(); });
    await settle();
    expect(listHunks(editor.prosemirrorView.state.doc)).toHaveLength(1);
    expect(editor.prosemirrorView.state.doc.textContent).not.toContain("First old claim.");
    expect(editor.prosemirrorView.state.doc.textContent).toContain("First revised claim.");
    expect(editor.prosemirrorView.state.doc.textContent).toContain("Second old claim.");
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Reject edit 1"]')!.click(); });
    await settle();
    expect(listHunks(editor.prosemirrorView.state.doc)).toHaveLength(0);
    expect(editor.prosemirrorView.state.doc.textContent).not.toContain("Second revised claim.");
    expect(container.querySelectorAll(".sp-margin-card")).toHaveLength(1);
    await act(async () => { container.querySelector<HTMLButtonElement>(".sp-margin-link")!.click(); });
    await settle();
    const reply = document.querySelector<HTMLTextAreaElement>('.sp-persistent-thread .bn-comment-editor textarea')!;
    expect(reply).not.toBeNull();
    await act(async () => { reply.value = "An unsent reply must survive."; reply.dispatchEvent(new dom.Event("input", { bubbles: true }) as any); });
    await settle();
    await act(async () => { paneWidth = 600; resizeListeners.forEach(listener => listener()); });
    await settle();
    expect(document.querySelector('.sp-persistent-thread .bn-comment-editor textarea')).toBe(reply);
    expect(reply.value).toContain("An unsent reply must survive.");
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Toggle notes"]')!.click(); });
    await settle();
    expect(document.querySelector('.sp-persistent-thread .bn-comment-editor textarea')).toBe(reply);
    await act(async () => { paneWidth = 1100; resizeListeners.forEach(listener => listener()); container.querySelector<HTMLButtonElement>('[aria-label="Toggle notes"]')!.click(); });
    await settle();
    expect(document.querySelector('.sp-persistent-thread .bn-comment-editor textarea')).toBe(reply);
    expect(reply.value).toContain("An unsent reply must survive.");
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Resolve comment 1"]')!.click(); });
    await settle();
    expect(readThreads(threads)[0].meta.status).toBe("resolved");
    expect(container.querySelectorAll(".sp-margin-card")).toHaveLength(0);
    await act(async () => {
      updateThreadMeta(threads, noteId, { status: "open" });
      const r = editor.getExtension(CommentsExtension)!.store.state.threadPositions.get(noteId)!;
      editor.prosemirrorView.dispatch(editor.prosemirrorView.state.tr.delete(r.from, r.to));
    });
    await settle();
    expect(container.querySelectorAll(".sp-margin-card")).toHaveLength(0);
    expect(readThreads(threads)).toHaveLength(1); // Detached is not silently deleted.
  } finally { await act(async () => { root.unmount(); }); editor._tiptapEditor.destroy(); container.remove(); ydoc.destroy(); }
});

afterAll(() => {
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  dom.happyDOM.abort();
});
