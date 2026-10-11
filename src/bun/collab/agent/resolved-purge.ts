import * as Y from "yjs";
import { EditorState } from "prosemirror-state";
import type { CollabSession } from "../registry";
import { COLLAB_FRAGMENT, COLLAB_THREADS_MAP } from "../../../shared/collab/protocol";
import { canonicalFindingFingerprint } from "../../../shared/collab/review";
import type { ThreadMeta } from "../../../shared/collab/threads";
import { blockAt, findBlock, readDoc, writeBlock } from "./doc-model";
import { rememberResolvedReviewBlocks } from "./resolved-review";

/** Fingerprints of findings the author dismissed, so review never raises them again. */
export const DISMISSED_FINDINGS_MAP = "dismissedFindings";
/** Lets the agent finish writing to a thread it just resolved. */
export const PURGE_DELAY_MS = 5_000;

/**
 * Resolved and deleted comments are settled, so they are removed from the
 * document entirely: thread, replies and comment marks. Only the ledgers
 * review needs survive (dismissed findings and retired paragraphs).
 */
export function purgeResolvedThreads(session: CollabSession, origin: unknown, now = Date.now()) {
  // A document still loading has no marks to clean up yet.
  if (session.seeding || session.ydoc.getXmlFragment(COLLAB_FRAGMENT).length === 0) return 0;
  const map = session.ydoc.getMap(COLLAB_THREADS_MAP);
  const entries = [...map.entries()].filter((entry): entry is [string, Y.Map<any>] => entry[1] instanceof Y.Map);
  const metaOf = (thread: Y.Map<any>) => (thread.get("metadata") as ThreadMeta | undefined) ?? {};
  // A coordinated revision aborts if comments or the document change while it runs.
  if (entries.some(([, thread]) => !thread.get("deletedAt") && !thread.get("resolved") &&
    metaOf(thread).documentAction === "resolve-comments" && metaOf(thread).assignee === "ai")) return 0;
  const due = entries.filter(([, thread]) => {
    const meta = metaOf(thread);
    const deletedAt = thread.get("deletedAt") as number | undefined;
    if (deletedAt) return now - deletedAt >= PURGE_DELAY_MS;
    if (!thread.get("resolved") && meta.status !== "resolved") return false;
    // The watermark result card reads its thread until the author dismisses it.
    if (meta.watermarkResult && meta.resultDismissedAt === undefined) return false;
    const resolvedAt = (thread.get("resolvedUpdatedAt") ?? thread.get("updatedAt") ?? 0) as number;
    return now - resolvedAt >= PURGE_DELAY_MS;
  });
  if (!due.length) return 0;

  // Retire resolved paragraphs from automatic review while the threads still say which ones.
  rememberResolvedReviewBlocks(session, origin);
  const ids = new Set(due.map(([id]) => id));
  const doc = readDoc(session);
  let tr = EditorState.create({ schema: session.schema, doc }).tr;
  const blocks = new Set<string>();
  doc.descendants((node, pos) => {
    for (const mark of node.marks) {
      if (mark.type.name !== "comment" || !ids.has(mark.attrs.threadId)) continue;
      tr = tr.removeMark(pos, pos + node.nodeSize, mark);
      const block = blockAt(doc, pos);
      if (block) blocks.add(block.id);
    }
    return true;
  });
  const dismissed = session.ydoc.getMap<boolean>(DISMISSED_FINDINGS_MAP);
  session.ydoc.transact(() => {
    for (const [, thread] of due) {
      const fingerprint = canonicalFindingFingerprint(metaOf(thread));
      if (fingerprint) dismissed.set(fingerprint, true);
    }
    for (const id of blocks) {
      const block = findBlock(tr.doc, id);
      if (block) writeBlock(session, block.node, origin);
    }
    for (const id of ids) map.delete(id);
  }, origin);
  return ids.size;
}
