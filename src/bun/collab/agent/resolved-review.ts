import type { CollabSession } from "../registry";
import { COLLAB_THREADS_MAP } from "../../../shared/collab/protocol";
import { isAIUser } from "../../../shared/collab/personas";
import { readThreads } from "../../../shared/collab/threads";
import { blocksInRange, hasInlineContent, readDoc, threadRange } from "./doc-model";

/** Permanent per-paragraph opt-out from automatic review, saved with the document. */
export const RESOLVED_REVIEW_BLOCKS_MAP = "resolvedReviewBlocks";

/** Also backfills documents resolved before this policy existed. */
export function rememberResolvedReviewBlocks(session: CollabSession, origin: unknown) {
  const { ydoc } = session;
  const resolved = ydoc.getMap<boolean>(RESOLVED_REVIEW_BLOCKS_MAP);
  let doc: ReturnType<typeof readDoc> | undefined;
  const ids = readThreads(ydoc.getMap(COLLAB_THREADS_MAP))
    .filter(thread => (thread.resolved || thread.meta.status === "resolved") &&
      (isAIUser(thread.meta.agent) || thread.comments.some(comment => isAIUser(comment.userId))))
    .flatMap(thread => {
      const ids = [...(thread.meta.editedBlockIds ?? []), ...(thread.meta.blockId ? [thread.meta.blockId] : [])];
      // Older and author-created passage threads may only have a comment anchor.
      // A document-wide request's anchor does not mean every paragraph was fixed.
      if (!ids.length && thread.meta.scope !== "document") {
        doc ??= readDoc(session);
        const range = threadRange(doc, thread.id);
        if (range) ids.push(...blocksInRange(doc, range.from, range.to).filter(hasInlineContent).map(block => block.id));
      }
      return ids;
    })
    .filter((id): id is string => !!id && !resolved.has(id));
  if (!ids.length) return;
  // Separate map entries merge independently across peers. Never clear these on
  // text edits, thread deletion/reopening, or an explicit one-off manual review.
  ydoc.transact(() => {
    for (const id of ids) resolved.set(id, true);
  }, origin);
}
