import type { CollabSession } from "../registry";
import { COLLAB_FRAGMENT, COLLAB_THREADS_MAP } from "../../../shared/collab/protocol";
import { isAIUser } from "../../../shared/collab/personas";
import { readThreads, updateThreadMeta } from "../../../shared/collab/threads";

/** Exact legacy rule text, not a general filter for substantive definition comments. */
function isLegacyNotice(text: string) {
  const match = /^([A-Za-z][A-Za-z0-9]*) is used here for the first time without being spelled out\. (.+)$/.exec(text);
  if (!match) return false;
  return match[2] === "Spell it out at its first use, or add it to the project glossary as a common abbreviation."
    || (match[2].startsWith('Write "') && match[2].endsWith(` (${match[1]})" here, as the project glossary defines it.`));
}

/** Let the existing resolved-thread cleanup remove obsolete, untouched automatic notices. */
export function retireAbbreviationNotices(session: CollabSession, origin: unknown) {
  if (session.seeding || session.ydoc.getXmlFragment(COLLAB_FRAGMENT).length === 0) return 0;
  const map = session.ydoc.getMap(COLLAB_THREADS_MAP);
  const threads = readThreads(map);
  if (threads.some(thread => !thread.resolved && thread.meta.documentAction === "resolve-comments" && thread.meta.assignee === "ai")) return 0;
  const obsolete = threads.filter(thread => {
    const { meta, comments } = thread;
    return !thread.resolved && (meta.status ?? "open") === "open" && meta.category === "definition"
      && isAIUser(meta.agent) && !!meta.fingerprint && !meta.manual && !meta.muted
      && meta.assignee !== "ai" && !meta.bulkRequestId && meta.changeSet === undefined
      && !meta.documentAction && !meta.scope && !meta.requestedAt && !meta.decision
      && comments.length === 1 && !comments[0].deleted && isAIUser(comments[0].userId)
      && isLegacyNotice(comments[0].text);
  });
  session.ydoc.transact(() => {
    for (const thread of obsolete) {
      updateThreadMeta(map, thread.id, { status: "resolved", autoResolved: "obsolete-abbreviation-rule" });
    }
  }, origin);
  return obsolete.length;
}
