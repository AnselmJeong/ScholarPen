import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import type { BlockNoteEditor } from "@blocknote/core";
import { COLLAB_THREADS_MAP } from "@shared/collab/protocol";
import { addThreadComment, AI_USER_ID, readThreads, updateThreadMeta } from "@shared/collab/threads";
import { setEditorCollab } from "../collab/editor-collab";
import type { CollabPeer } from "../collab/collab-peer";
import {
  describeDocumentEdit,
  sendDocumentEditRequest,
  waitForDocumentEditor,
  watchDocumentEdit,
  type DocumentEditProgress,
} from "./document-edit-request";

function joinedEditor() {
  const editor = {} as BlockNoteEditor<any, any, any>;
  const ydoc = new Y.Doc();
  setEditorCollab(editor, { ydoc } as CollabPeer);
  return { editor, ydoc };
}

describe("sendDocumentEditRequest", () => {
  test("saves the instruction as the author's whole-manuscript request to ScholarPen AI", () => {
    const { editor, ydoc } = joinedEditor();
    const sent = sendDocumentEditRequest(editor, "Remove the sentence on sampling and rewrite the paragraph.");
    const [thread] = readThreads(ydoc.getMap(COLLAB_THREADS_MAP));
    expect(sent?.threadId).toBe(thread.id);
    expect(thread.meta).toMatchObject({ assignee: "ai", status: "open", scope: "document" });
    expect(thread.comments.map(comment => [comment.userId, comment.text]))
      .toEqual([["me", "Remove the sentence on sampling and rewrite the paragraph."]]);
  });

  test("needs an editor joined to its shared document", () => {
    expect(sendDocumentEditRequest({} as BlockNoteEditor<any, any, any>, "Edit")).toBeNull();
  });
});

describe("watchDocumentEdit", () => {
  test("follows the request from queued to ScholarPen AI's answer", () => {
    const { editor, ydoc } = joinedEditor();
    const sent = sendDocumentEditRequest(editor, "Shorten the discussion.")!;
    const threads = ydoc.getMap(COLLAB_THREADS_MAP);
    const seen: DocumentEditProgress[] = [];
    watchDocumentEdit(sent, progress => seen.push(progress));

    updateThreadMeta(threads, sent.threadId, { status: "in-progress" });
    ydoc.transact(() => {
      addThreadComment(threads, sent.threadId, AI_USER_ID, "Suggested changes in 2 paragraphs.");
      updateThreadMeta(threads, sent.threadId, { assignee: "me", status: "proposed", statusNote: "2 suggestions" });
    });
    updateThreadMeta(threads, sent.threadId, { status: "resolved" });

    expect(seen).toEqual([
      { state: "queued" },
      { state: "working" },
      { state: "done", reply: "Suggested changes in 2 paragraphs.", failed: false },
    ]);
  });

  test("reports a failed job and a thread removed before any answer", () => {
    const first = joinedEditor();
    const failed = sendDocumentEditRequest(first.editor, "Edit")!;
    const failures: DocumentEditProgress[] = [];
    watchDocumentEdit(failed, progress => failures.push(progress));
    const threads = first.ydoc.getMap(COLLAB_THREADS_MAP);
    first.ydoc.transact(() => {
      addThreadComment(threads, failed.threadId, AI_USER_ID, "The task stopped: timeout");
      updateThreadMeta(threads, failed.threadId, { assignee: "me", status: "open", statusNote: "Failed: timeout" });
    });
    expect(failures.at(-1)).toEqual({ state: "done", reply: "The task stopped: timeout", failed: true });

    const second = joinedEditor();
    const removed = sendDocumentEditRequest(second.editor, "Edit")!;
    const states: string[] = [];
    watchDocumentEdit(removed, progress => states.push(progress.state));
    second.ydoc.getMap(COLLAB_THREADS_MAP).delete(removed.threadId);
    expect(states).toEqual(["queued", "gone"]);
  });
});

describe("waitForDocumentEditor", () => {
  test("waits until the opened document's editor has joined its shared document", async () => {
    const editor = {} as BlockNoteEditor<any, any, any>;
    let mounted: typeof editor | null = null;
    setTimeout(() => { mounted = editor; }, 20);
    setTimeout(() => setEditorCollab(editor, { ydoc: new Y.Doc() } as CollabPeer), 40);
    expect(await waitForDocumentEditor(() => mounted, 1_000, 5)).toBe(editor);
  });

  test("gives up when the document never opens", async () => {
    expect(await waitForDocumentEditor(() => null, 30, 5)).toBeNull();
  });
});

describe("describeDocumentEdit", () => {
  test("tells the author where to review a finished edit", () => {
    const notice = describeDocumentEdit({ state: "done", reply: "2개 문단을 고쳤습니다.", failed: false }, "Methods_Results", "ko");
    expect(notice.status).toBe("success");
    expect(notice.description).toContain("2개 문단을 고쳤습니다.");
    expect(notice.description).toContain("추적 변경");
    expect(describeDocumentEdit({ state: "refused", reason: "not-found" }, "Methods_Results", "en").status).toBe("warning");
  });
});
