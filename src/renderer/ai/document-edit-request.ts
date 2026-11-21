import type { BlockNoteEditor } from "@blocknote/core";
import type * as Y from "yjs";
import { COLLAB_THREADS_MAP } from "@shared/collab/protocol";
import { isAIUser } from "@shared/collab/personas";
import { createThread, LOCAL_USER_ID, readThreads, type ThreadSnapshot } from "@shared/collab/threads";
import { getEditorCollab } from "../collab/editor-collab";

/** A whole-manuscript request the Assistant handed to ScholarPen AI. */
export interface SentDocumentEdit {
  ydoc: Y.Doc;
  threadId: string;
}

/** Why a request could not be handed over: the document is not in the project, or its editor never joined the shared document. */
export type DocumentEditDispatch = { ok: true; sent: SentDocumentEdit } | { ok: false; reason: "not-found" | "not-ready" };

export type DocumentEditProgress =
  | { state: "queued" }
  | { state: "working" }
  | { state: "done"; reply: string; failed: boolean }
  /** The thread was removed (resolved and purged, or deleted) before ScholarPen AI answered. */
  | { state: "gone" };

/**
 * Saves the instruction as the author's whole-manuscript request to
 * ScholarPen AI: the same thread the slash menu makes without a selection, so
 * the document's edit level, zones and tracked changes all apply.
 */
export function sendDocumentEditRequest(editor: BlockNoteEditor<any, any, any>, instruction: string): SentDocumentEdit | null {
  const peer = getEditorCollab(editor);
  if (!peer) return null;
  let threadId = "";
  peer.ydoc.transact(() => {
    threadId = createThread(peer.ydoc.getMap(COLLAB_THREADS_MAP), LOCAL_USER_ID, instruction, {
      assignee: "ai", status: "open", requestedAt: Date.now(), scope: "document",
    });
  }, "assistant-edit-request");
  return { ydoc: peer.ydoc, threadId };
}

/** Waits until the document's editor is mounted and joined to its shared Y.Doc. */
export async function waitForDocumentEditor(
  find: () => BlockNoteEditor<any, any, any> | null,
  timeoutMs = 20_000,
  intervalMs = 200,
): Promise<BlockNoteEditor<any, any, any> | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const editor = find();
    if (editor && getEditorCollab(editor)) return editor;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function documentEditProgress(thread: ThreadSnapshot | undefined): DocumentEditProgress {
  if (!thread) return { state: "gone" };
  const answered = thread.comments.filter((comment) => !comment.deleted && isAIUser(comment.userId)).at(-1);
  const busy = thread.meta.status === "in-progress";
  if (answered && !busy && thread.meta.assignee !== "ai") {
    const note = thread.meta.statusNote ?? "";
    return { state: "done", reply: answered.text, failed: /^(Failed:|Cancelled)/.test(note) };
  }
  return busy ? { state: "working" } : { state: "queued" };
}

/** Reports the request's progress now and on every change, until it is answered or removed. */
export function watchDocumentEdit(sent: SentDocumentEdit, onProgress: (progress: DocumentEditProgress) => void): () => void {
  const threads = sent.ydoc.getMap(COLLAB_THREADS_MAP);
  let last = "";
  let finished = false;
  const check = () => {
    if (finished) return;
    const progress = documentEditProgress(readThreads(threads).find((thread) => thread.id === sent.threadId));
    const key = JSON.stringify(progress);
    if (key === last) return;
    last = key;
    onProgress(progress);
    if (progress.state === "done" || progress.state === "gone") stop();
  };
  const stop = () => {
    finished = true;
    threads.unobserveDeep(check);
  };
  threads.observeDeep(check);
  check();
  return stop;
}

export interface DocumentEditNotice {
  status: "info" | "success" | "warning";
  title: string;
  description?: string;
}

const REPLY_LIMIT = 600;

/** The Assistant tab's banner for one request, in the chat's language. */
export function describeDocumentEdit(
  progress: DocumentEditProgress | { state: "sending" } | { state: "refused"; reason: "invalid-target" | "unfinished" | "not-found" | "not-ready" },
  name: string,
  lang: "ko" | "en",
): DocumentEditNotice {
  const ko = lang === "ko";
  switch (progress.state) {
    case "sending":
      return { status: "info", title: ko ? `${name} 문서에 보낼 수정 요청을 준비하고 있습니다…` : `Preparing the edit request for ${name}…` };
    case "queued":
      return { status: "info", title: ko ? `ScholarPen AI에 ${name} 수정 요청을 보냈습니다. 곧 작업을 시작합니다.` : `Sent to ScholarPen AI. Editing ${name} starts shortly.` };
    case "working":
      return {
        status: "info",
        title: ko ? `ScholarPen AI가 ${name}을(를) 고치고 있습니다.` : `ScholarPen AI is editing ${name}.`,
        description: ko ? "진행 상황은 Activity 탭에서 볼 수 있습니다." : "Follow its progress in the Activity tab.",
      };
    case "done": {
      const reply = progress.reply.length > REPLY_LIMIT ? `${progress.reply.slice(0, REPLY_LIMIT)}…` : progress.reply;
      if (progress.failed) {
        return { status: "warning", title: ko ? `ScholarPen AI가 ${name} 수정을 마치지 못했습니다.` : `ScholarPen AI could not finish editing ${name}.`, description: reply };
      }
      return {
        status: "success",
        title: ko ? `ScholarPen AI가 ${name} 요청에 답했습니다.` : `ScholarPen AI answered the request for ${name}.`,
        description: `${reply}${reply ? "\n" : ""}${ko
          ? "바뀐 부분은 문서에 추적 변경으로 표시됩니다. Keep 또는 Revert로 결정하세요."
          : "Changes appear in the document as tracked changes to keep or revert."}`,
      };
    }
    case "gone":
      return { status: "info", title: ko ? `${name} 수정 요청 스레드가 정리되었습니다. Activity 탭에서 결과를 확인하세요.` : `The request thread for ${name} was closed. Check the Activity tab.` };
    case "refused": {
      const titles = {
        "invalid-target": ko ? `'${name}'은(는) 이 프로젝트의 원고 문서가 아니어서 수정 요청을 보내지 않았습니다.` : `'${name}' is not a manuscript of this project, so no edit request was sent.`,
        unfinished: ko ? "수정 요청이 끝까지 작성되지 않아 보내지 않았습니다. 다시 요청해 주세요." : "The edit request was cut off, so it was not sent. Please ask again.",
        "not-found": ko ? `프로젝트에서 ${name} 문서를 찾지 못해 수정 요청을 보내지 않았습니다.` : `${name} was not found in the project, so no edit request was sent.`,
        "not-ready": ko ? `${name} 문서를 열지 못해 수정 요청을 보내지 않았습니다. 문서를 연 뒤 다시 요청해 주세요.` : `${name} could not be opened, so no edit request was sent. Open it and ask again.`,
      };
      return { status: "warning", title: titles[progress.reason] };
    }
  }
}
