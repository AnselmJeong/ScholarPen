import { useEffect, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { CHANGE_SETS_MAP, type ChangeSetInfo } from "../../shared/collab/change-sets";
import { COLLAB_THREADS_MAP } from "../../shared/collab/protocol";
import { readThreads, updateThreadMeta } from "../../shared/collab/threads";
import { getEditorCollab } from "./editor-collab";
import { listChangeSets, resolveAllChangeSets, resolveChangeSet, type PendingChangeSet } from "./suggestions";

/** Pending AI change sets in the editor, kept current as the document changes. */
export function usePendingChangeSets(editor: BlockNoteEditor<any, any, any> | null) {
  const [sets, setSets] = useState<PendingChangeSet[]>([]);
  useEffect(() => {
    if (!editor) {
      setSets([]);
      return;
    }
    const infos = getEditorCollab(editor)?.ydoc.getMap<ChangeSetInfo>(CHANGE_SETS_MAP);
    const refresh = () => {
      const doc = editor.prosemirrorView?.state.doc;
      setSets(doc ? listChangeSets(doc, infos) : []);
    };
    refresh();
    infos?.observe(refresh);
    const off = editor.onChange(refresh);
    return () => {
      off();
      infos?.unobserve(refresh);
    };
  }, [editor]);
  return sets;
}

/**
 * Accepts or rejects a change set (or one paragraph of it) and, once nothing
 * of it is left pending, closes the loop on the thread that asked for it.
 */
export function decideChangeSet(
  editor: BlockNoteEditor<any, any, any>,
  id: string | number,
  accept: boolean,
  range?: { from: number; to: number },
) {
  if (!resolveChangeSet(editor, id, accept, range)) return;
  settleThreads(editor, [id], accept);
}

export function decideAllChangeSets(editor: BlockNoteEditor<any, any, any>, accept: boolean) {
  settleThreads(editor, resolveAllChangeSets(editor, accept), accept);
}

function settleThreads(editor: BlockNoteEditor<any, any, any>, ids: Array<string | number>, accept: boolean) {
  const collab = getEditorCollab(editor);
  const doc = editor.prosemirrorView?.state.doc;
  if (!collab || !doc) return;
  const stillPending = new Set(listChangeSets(doc).map((set) => String(set.id)));
  const infos = collab.ydoc.getMap<ChangeSetInfo>(CHANGE_SETS_MAP);
  const threads = collab.ydoc.getMap(COLLAB_THREADS_MAP);
  collab.ydoc.transact(() => {
    for (const id of ids) {
      const info = infos.get(String(id));
      if (stillPending.has(String(id))) {
        if (!accept && info) infos.set(String(id), { ...info, rejected: true });
        continue;
      }
      const acceptedEntirely = accept && !info?.rejected;
      for (const threadId of new Set([info?.threadId, ...(info?.addressedThreadIds ?? [])])) {
        if (!threadId) continue;
        const thread = readThreads(threads).find(item => item.id === threadId);
        // Do not undo Resolve all or overwrite a newer request's state.
        if (!thread || thread.resolved || (thread.meta.changeSet !== undefined && String(thread.meta.changeSet) !== String(id))) continue;
        updateThreadMeta(threads, threadId, acceptedEntirely
          ? { status: "resolved", statusNote: undefined, changeSet: undefined }
          : { status: "open", assignee: "me", manual: true, changeSet: undefined,
            statusNote: "The revision was not accepted in full. This comment remains open." });
      }
      infos.delete(String(id));
    }
  });
}
