import type * as Y from "yjs";
import { COLLAB_THREADS_MAP } from "./protocol";
import { addThreadComment, LOCAL_USER_ID, readThreads, updateThreadMeta, type ThreadSnapshot } from "./threads";
import { aiTaskRunning, requestBulkComments } from "./bulk-comments";
import type { EditLevel } from "./writing";

/**
 * The author's decision queue: questions ScholarPen AI could not settle on
 * its own (a thesis choice, missing data, an unverified source). Answering one
 * hands the thread back to the AI, which continues with the answer.
 */
export function openDecisions(threads: ThreadSnapshot[]) {
  return threads.filter(thread => !!thread.meta.decision && !thread.resolved && thread.meta.status !== "resolved" &&
    thread.meta.status !== "in-progress" && !thread.meta.bulkRequestId)
    .sort((a, b) => a.meta.decision!.askedAt - b.meta.decision!.askedAt);
}

/** Posts the answer and asks the AI to continue on this thread. */
export function answerDecision(ydoc: Y.Doc, threadId: string, answer: string) {
  const text = answer.trim();
  if (!text) throw new Error("Write an answer first.");
  const map = ydoc.getMap(COLLAB_THREADS_MAP);
  ydoc.transact(() => {
    addThreadComment(map, threadId, LOCAL_USER_ID, text);
    updateThreadMeta(map, threadId, {
      assignee: "ai", manual: undefined, requestedAt: Date.now(), decision: undefined, status: "open", statusNote: undefined,
    });
  });
}

/**
 * Posts every answer, then asks for one coordinated revision across all open
 * comments, so related decisions are applied consistently. Nothing is posted
 * when a coordinated revision cannot start.
 */
export function answerDecisionsTogether(ydoc: Y.Doc, answers: Map<string, string>, level?: EditLevel) {
  const map = ydoc.getMap(COLLAB_THREADS_MAP);
  const given = [...answers].map(([id, text]) => [id, text.trim()] as const).filter(([, text]) => text);
  if (!given.length) throw new Error("Write at least one answer first.");
  if (aiTaskRunning(readThreads(map))) throw new Error("Wait for the current AI task to finish before sending your answers.");
  let request = "";
  ydoc.transact(() => {
    for (const [id, text] of given) {
      addThreadComment(map, id, LOCAL_USER_ID, text);
      updateThreadMeta(map, id, { decision: undefined, status: "open", statusNote: "Answered; part of the next coordinated revision." });
    }
    request = requestBulkComments(ydoc,
      "Apply my answers to your open questions together, and address the remaining open comments consistently with them.", level);
  });
  return request;
}

/** The author will decide outside the AI; the thread stays open as theirs. */
export function dismissDecision(ydoc: Y.Doc, threadId: string) {
  ydoc.transact(() => updateThreadMeta(ydoc.getMap(COLLAB_THREADS_MAP), threadId, { decision: undefined, assignee: "me", manual: true }));
}
