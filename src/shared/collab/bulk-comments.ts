import type * as Y from "yjs";
import { COLLAB_THREADS_MAP } from "./protocol";
import { createThread, readThreads, updateThreadMeta, type ThreadSnapshot } from "./threads";

export function openClaimThreads(threads: ThreadSnapshot[]) {
  return threads.filter(thread => !thread.resolved && thread.meta.status !== "resolved" &&
    !thread.meta.documentAction && thread.comments.some(comment => !comment.deleted));
}

/** One request, rather than one independently queued edit per comment. */
export function requestBulkComments(ydoc: Y.Doc, instructions = "") {
  const map = ydoc.getMap(COLLAB_THREADS_MAP);
  const all = readThreads(map);
  if (all.some(thread => !thread.resolved && (thread.meta.status === "in-progress" ||
    (thread.meta.documentAction === "resolve-comments" && thread.meta.assignee === "ai")))) {
    throw new Error("Wait for the current AI task to finish before asking for a coordinated revision.");
  }
  const targets = openClaimThreads(all);
  if (!targets.length) throw new Error("There are no open comments to address.");
  let id = "";
  ydoc.transact(() => {
    id = createThread(map, "me", instructions.trim() ||
      "Address all open comments together across the whole manuscript. Keep issues requiring my decision open, and propose one consistent revision.", {
      assignee: "ai", scope: "document", documentAction: "resolve-comments",
      bulkThreadIds: targets.map(thread => thread.id), requestedAt: Date.now(),
    });
    for (const thread of targets) updateThreadMeta(map, thread.id, {
      assignee: "me", manual: true, bulkRequestId: id,
    });
  });
  return id;
}

/** Dismiss comments only; never accepts suggestions or changes manuscript text. */
export function resolveAllComments(ydoc: Y.Doc) {
  const map = ydoc.getMap(COLLAB_THREADS_MAP);
  const targets = readThreads(map).filter(thread => !thread.resolved && thread.meta.status !== "resolved");
  ydoc.transact(() => {
    for (const thread of targets) updateThreadMeta(map, thread.id, {
      status: "resolved", assignee: "me", manual: true, bulkRequestId: undefined,
      statusNote: "Dismissed with Resolve all; manuscript unchanged.",
    });
  });
  return targets.length;
}
