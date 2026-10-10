import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act, useMemo } from "react";
import { createRoot } from "react-dom/client";

const dom = new Window({ url: "http://localhost" });
Object.defineProperty(dom.document, "compatMode", { value: "CSS1Compat" });
const keys = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLInputElement", "DocumentFragment", "MutationObserver", "ResizeObserver", "DOMParser", "DOMRect", "Text", "NodeFilter", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true,
  value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.happyDOM.abort();
});

mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const realRpc = { ...(await import("../rpc")) };
let requestedProject = "";
mock.module("../rpc", () => ({ ...realRpc, rpc: { ...realRpc.rpc,
  listAgentMentionableFiles: async (projectPath: string) => {
    requestedProject = projectPath;
    return [
      { name: "exports", path: "/p/exports", displayPath: "exports/", kind: "folder" },
      { name: "references.bib", path: "/p/exports/references.bib", displayPath: "exports/references.bib", kind: "note" },
      { name: "한글 원고.qmd", path: "/p/한글 원고.qmd", displayPath: "한글 원고.qmd", kind: "note" },
    ];
  },
} }));

const { BlockNoteEditor } = await import("@blocknote/core");
const { CommentsExtension, YjsThreadStore, DefaultThreadStoreAuth } = await import("@blocknote/core/comments");
const { BlockNoteView } = await import("@blocknote/mantine");
const { ComponentsContext, useComponentsContext } = await import("@blocknote/react");
const { CommentFileMentionsProvider } = await import("./comment-file-mentions");
const { ScholarFloatingThread } = await import("./comment-composer");
const { commentBodyText } = await import("../../shared/collab/threads");
const Y = await import("yjs");

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}

test("reply picker selects with Enter, preserves text around the cursor, and only the next Enter saves", async () => {
  const ydoc = new Y.Doc();
  const store = new YjsThreadStore("me", ydoc.getMap("threads"), new DefaultThreadStoreAuth("me", "editor"));
  const thread = await store.createThread({ initialComment: { body: [{ type: "paragraph", content: "Please add supporting citations." }] } });
  const editor = BlockNoteEditor.create({ extensions: [CommentsExtension({ threadStore: store, resolveUsers: async ids => ids.map(id => ({ id, username: "You", avatarUrl: "" })) })] });
  let replyEditor: import("@blocknote/core").BlockNoteEditor<any, any, any> | undefined;
  function Capture({ children }: { children: React.ReactNode }) {
    const components = useComponentsContext()!;
    const value = useMemo(() => ({ ...components, Comments: { ...components.Comments,
      Editor: (props: React.ComponentProps<typeof components.Comments.Editor>) => {
        if (props.editable) replyEditor = props.editor;
        return <components.Comments.Editor {...props} />;
      },
    } }), [components]);
    return <ComponentsContext.Provider value={value}>{children}</ComponentsContext.Provider>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<BlockNoteView editor={editor} comments={false} formattingToolbar={false} sideMenu={false} slashMenu={false}>
      <CommentFileMentionsProvider projectPath="/p"><Capture>
        <ScholarFloatingThread thread={thread} selected />
      </Capture></CommentFileMentionsProvider>
    </BlockNoteView>));
    await settle();
    expect(replyEditor).toBeDefined();
    const reply = replyEditor!;
    await act(async () => {
      reply.insertInlineContent("Use  for citations");
      // Insert a reference in the middle of a reply, retaining its suffix.
      const view = reply.prosemirrorView;
      const { TextSelection } = await import("prosemirror-state");
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7)));
      reply.focus();
      const { from, to } = view.state.selection;
      view.someProp("handleTextInput", handler => handler(view, from, to, "@", () => view.state.tr.insertText("@")));
      reply.insertInlineContent("ref");
    });
    await settle();
    expect(requestedProject).toBe("/p");
    expect(document.querySelector('[data-file-mention-open="true"]')).not.toBeNull();
    expect(document.body.textContent).toContain("exports/references.bib");
    await act(async () => { reply.domElement!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as any); });
    await settle();
    expect(commentBodyText(reply.document)).toBe("Use @[exports/references.bib]  for citations");
    expect(store.getThread(thread.id).comments).toHaveLength(1);
    await act(async () => { reply.domElement!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as any); });
    await settle();
    expect(store.getThread(thread.id).comments).toHaveLength(2);
    expect(commentBodyText(store.getThread(thread.id).comments[1].body)).toContain("@[exports/references.bib]");

    // Folder selection expands on the backend; the saved token is an exact
    // project-relative path. An IME confirmation must not select or submit it.
    await act(async () => {
      reply.setTextCursorPosition(reply.document[0], "start");
      reply.focus();
      const view = reply.prosemirrorView;
      const { from, to } = view.state.selection;
      view.someProp("handleTextInput", handler => handler(view, from, to, "@", () => view.state.tr.insertText("@")));
    });
    await settle();
    await act(async () => { reply.domElement!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }) as any); });
    expect(store.getThread(thread.id).comments).toHaveLength(2);
    expect(commentBodyText(reply.document)).toBe("@");
    await act(async () => { reply.domElement!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as any); });
    await settle();
    expect(commentBodyText(reply.document)).toBe("@[exports/]");
    expect(store.getThread(thread.id).comments).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    ydoc.destroy();
  }
});
