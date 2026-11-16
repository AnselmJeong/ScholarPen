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
Object.defineProperty(dom.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1100 });
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } });
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
mock.module("../../collab/comment-composer", () => ({ ScholarFloatingThread: () => null }));
const { BlockNoteEditor } = await import("@blocknote/core");
const { BlockNoteViewRaw: BlockNoteView } = await import("@blocknote/react");
const { CommentsExtension, DefaultThreadStoreAuth, YjsThreadStore } = await import("@blocknote/core/comments");
const { ReviewMargin } = await import("./ReviewMargin");
const { createReviewStore, SuggestionReviewExtension } = await import("../../collab/suggestion-review");
const { setEditorCollab } = await import("../../collab/editor-collab");
const { createThread, readThreads } = await import("../../../shared/collab/threads");
const { COLLAB_THREADS_MAP } = await import("../../../shared/collab/protocol");
const { REVIEW_PROPOSALS_MAP } = await import("../../../shared/collab/review-proposals");
const { listHunks } = await import("../../collab/suggestion-hunks");

async function settle() { for (let i = 0; i < 3; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }

const proposal = (key: string, id: string, blockId: string, before: string, after: string, changeSetId: number) => ({
  key, sessionId: "s", round: 1, id, document: "doc.scholarpen.json", blockId, before, after, origin: "applied",
  rationale: `${id} rationale`, comments: [{ id: `R1-${id}`, reviewerId: "R1", text: `Reviewer asks about ${id}.` }],
  state: "pending", changeSetId, placedAt: 1,
});

test("reviewer revisions get their own card, apart from AI review notes, and settle from it", async () => {
  const ydoc = new Y.Doc();
  const threads = ydoc.getMap(COLLAB_THREADS_MAP);
  const proposals = ydoc.getMap<any>(REVIEW_PROPOSALS_MAP);
  const threadStore = new YjsThreadStore("me", threads, new DefaultThreadStoreAuth("me", "editor"));
  const store = createReviewStore();
  const editor = BlockNoteEditor.create({
    initialContent: [
      { id: "a", type: "paragraph", content: "Tdcs was inferior to escitalopram." },
      { id: "b", type: "paragraph", content: "Patients must keep a positive mood. AI note target." },
    ],
    extensions: [CommentsExtension({ threadStore, resolveUsers: async () => [] }), SuggestionReviewExtension({ store })],
  });
  const peer = { ydoc, threadStore, docKey: "/p::doc.scholarpen.json", afterPushes: async () => {} };
  setEditorCollab(editor, peer as any);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  function Fixture() {
    const canvas = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null);
    const [, setP] = useState({ count: 0, wide: false });
    return <div ref={scroll}><div ref={canvas}>
      <BlockNoteView editor={editor} comments={false} formattingToolbar={false} slashMenu={false} sideMenu={false}>
        <ReviewMargin editor={editor} peer={peer as any} store={store} canvasRef={canvas} scrollRef={scroll} visible onPresentationChange={setP} />
      </BlockNoteView>
    </div></div>;
  }
  const range = (text: string) => {
    let found = { from: -1, to: -1 };
    editor.prosemirrorView.state.doc.descendants((node, pos) => { if (node.isText && node.text?.includes(text)) found = { from: pos + node.text.indexOf(text), to: pos + node.text.indexOf(text) + text.length }; });
    return found;
  };
  const suggest = (before: string, after: string, id: number) => {
    const at = range(before);
    editor.prosemirrorView.dispatch(editor.prosemirrorView.state.tr.addMark(at.from, at.to, editor.pmSchema.marks.deletion.create({ id }))
      .insert(at.to, editor.pmSchema.text(after, [editor.pmSchema.marks.insertion.create({ id })])));
  };
  try {
    await act(async () => { root.render(<Fixture />); });
    await act(async () => {
      suggest("was inferior to", "did not show non-inferiority to", 4);
      suggest("must keep a positive mood", "may take part actively if they wish", 5);
      ydoc.transact(() => {
        proposals.set("s/C1-p2", proposal("s/C1-p2", "C1-p2", "a", "was inferior to", "did not show non-inferiority to", 4));
        proposals.set("s/C1-p4", proposal("s/C1-p4", "C1-p4", "b", "must keep a positive mood", "may take part actively if they wish", 5));
      });
      const noteId = createThread(threads, "scholarpen-ai", "Consider defining this term.", {});
      const r = range("AI note target.");
      editor.prosemirrorView.dispatch(editor.prosemirrorView.state.tr.addMark(r.from, r.to, editor.pmSchema.marks.comment.create({ threadId: noteId })));
    });
    await settle();
    const cards = [...container.querySelectorAll<HTMLElement>(".sp-margin-card")];
    // Two proposals and one AI note; the proposals' tracked changes are not shown again as generic edits.
    expect(cards.map(card => card.dataset.kind)).toEqual(["proposal", "proposal", "comment"]);
    expect(cards[0].textContent).toContain("심사 반영");
    expect(cards[0].textContent).toContain("R1-C1-p2");
    expect(cards[0].textContent).toContain("Reviewer asks about C1-p2.");
    expect(cards[2].textContent).toContain("AI review");
    expect([...store.peer].sort()).toEqual(["4", "5"]);
    // The change is read in the text (redline), not repeated in the narrow card.
    expect(cards[0].textContent).not.toContain("was inferior to");
    expect(cards[0].textContent).toContain("취소선");
    // Clicking the redline in the text selects the proposal's card instead of the generic popover.
    await act(async () => { store.set({ active: store.hunks.findIndex(hunk => String(hunk.id) === "5"), open: true }); });
    await settle();
    expect(container.querySelector('.sp-margin-card[aria-label="Reviewer revision 2"]')!.getAttribute("data-active")).toBe("true");
    expect(store.open).toBe(false);

    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Accept Reviewer revision 1"]')!.click(); });
    await settle();
    expect(editor.prosemirrorView.state.doc.textContent).toContain("did not show non-inferiority to escitalopram");
    expect(proposals.get("s/C1-p2").state).toBe("accepted");
    expect(container.querySelectorAll('.sp-margin-card[data-kind="proposal"]')).toHaveLength(1);

    // Reject the second and ask for another version.
    const ask = [...container.querySelectorAll<HTMLButtonElement>(".sp-proposal-button")].find(button => button.textContent?.includes("거절하고 AI에게 다시 요청"))!;
    await act(async () => { ask.click(); });
    const field = container.querySelector<HTMLTextAreaElement>(".sp-proposal-ask textarea")!;
    await act(async () => { field.value = "Keep it optional and shorter."; });
    await act(async () => { container.querySelector<HTMLFormElement>(".sp-proposal-ask")!.requestSubmit(); });
    await settle();
    expect(listHunks(editor.prosemirrorView.state.doc)).toHaveLength(0);
    expect(editor.prosemirrorView.state.doc.textContent).toContain("must keep a positive mood");
    const entry = proposals.get("s/C1-p4");
    expect(entry).toMatchObject({ state: "redo", instruction: "Keep it optional and shorter.", redoCount: 1 });
    const thread = readThreads(threads).find(item => item.id === entry.threadId)!;
    expect(thread.meta).toMatchObject({ assignee: "ai", reviewProposal: "s/C1-p4", blockId: "b" });
    expect(thread.comments[0].text).toContain("Keep it optional and shorter.");
    expect(thread.comments[0].text).toContain("may take part actively if they wish");
    const waiting = container.querySelector<HTMLElement>('.sp-margin-card[data-kind="proposal"]')!;
    expect(waiting.textContent).toContain("AI가 새 수정안을 작성하는 중");
  } finally { await act(async () => { root.unmount(); }); editor._tiptapEditor.destroy(); container.remove(); ydoc.destroy(); }
});

afterAll(() => {
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  dom.happyDOM.abort();
});
