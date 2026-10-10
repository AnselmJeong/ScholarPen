import type { CollabSession } from "../registry";
import { COLLAB_FRAGMENT, COLLAB_THREADS_MAP } from "../../../shared/collab/protocol";
import { isAIUser } from "../../../shared/collab/personas";
import { normalizeReviewCategory } from "../../../shared/collab/review";
import { readThreads, updateThreadMeta, type ThreadSnapshot } from "../../../shared/collab/threads";
import { readDoc, readableText, threadRange } from "./doc-model";

/** A claim must stay stale this long, so undo and half-typed rewrites do not retire it. */
export const STALE_CLAIM_GRACE_MS = 20_000;
/** Share of the claimed words the author must have replaced before the claim no longer applies. */
const REWRITTEN_SHARE = 0.5;

export const STALE_CLAIM_NOTE = "Resolved automatically: the commented passage was deleted or rewritten.";

function words(text: string) {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Share of words changed between two texts (0 = identical, 1 = nothing in common), by word-level LCS. */
export function changedShare(before: string, after: string) {
  const a = words(before);
  const b = words(after);
  if (!a.length && !b.length) return 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (const word of a) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 0; j < b.length; j++) row[j + 1] = word === b[j] ? previous[j] + 1 : Math.max(previous[j + 1], row[j]);
    previous = row;
  }
  return 1 - (2 * previous[b.length]) / (a.length + b.length);
}

/** Open AI review findings that nobody is working on and the author has not discussed. */
function isUntouchedClaim(thread: ThreadSnapshot) {
  const { meta } = thread;
  if (thread.resolved || (meta.status ?? "open") !== "open") return false;
  if (!normalizeReviewCategory(meta.category) || !isAIUser(meta.agent)) return false;
  // A claim the author reopened after it was retired stays until they resolve it.
  if (meta.autoResolved || meta.assignee === "ai" || meta.bulkRequestId || meta.changeSet !== undefined || meta.scope === "document") return false;
  return thread.comments.every(comment => comment.deleted || isAIUser(comment.userId));
}

/**
 * Retires AI review claims the author's editing made irrelevant: the claimed
 * passage is gone, or most of its words were rewritten. Resolved, not deleted,
 * so a claim can be reopened from the Resolved tab.
 */
export class StaleClaimSweeper {
  /** First time each thread was seen stale, per document. */
  private readonly staleSince = new Map<string, Map<string, number>>();

  constructor(private readonly now: () => number = Date.now) {}

  sweep(session: CollabSession, origin: unknown) {
    const since = this.staleSince.get(session.docKey) ?? new Map<string, number>();
    this.staleSince.set(session.docKey, since);
    // An empty or seeding document has no anchors yet; it says nothing about the claims.
    if (session.seeding || session.ydoc.getXmlFragment(COLLAB_FRAGMENT).length === 0) return 0;
    const map = session.ydoc.getMap(COLLAB_THREADS_MAP);
    const doc = readDoc(session);
    if (!doc.textContent.trim()) return 0;
    const threads = readThreads(map);
    // A coordinated revision aborts if any comment changes while it runs.
    if (threads.some(thread => !thread.resolved && thread.meta.documentAction === "resolve-comments" && thread.meta.assignee === "ai")) return 0;
    const now = this.now();
    const due: string[] = [];
    const stale = new Set<string>();
    for (const thread of threads) {
      if (!isUntouchedClaim(thread)) continue;
      const range = threadRange(doc, thread.id);
      const anchorText = thread.meta.anchorText;
      if (range && !(anchorText && changedShare(anchorText, readableText(doc, range.from, range.to)) >= REWRITTEN_SHARE)) continue;
      stale.add(thread.id);
      const first = since.get(thread.id) ?? now;
      since.set(thread.id, first);
      if (now - first >= STALE_CLAIM_GRACE_MS) due.push(thread.id);
    }
    for (const id of since.keys()) if (!stale.has(id)) since.delete(id);
    if (!due.length) return 0;
    session.ydoc.transact(() => {
      for (const id of due) {
        updateThreadMeta(map, id, { status: "resolved", autoResolved: "stale", statusNote: STALE_CLAIM_NOTE });
        since.delete(id);
      }
    }, origin);
    return due.length;
  }

  forget(docKey: string) {
    this.staleSince.delete(docKey);
  }
}
