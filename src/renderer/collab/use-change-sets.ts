import { useEffect, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { CHANGE_SETS_MAP, type ChangeSetInfo } from "../../shared/collab/change-sets";
import { COLLAB_THREADS_MAP } from "../../shared/collab/protocol";
import { updateThreadMeta } from "../../shared/collab/threads";
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
      if (stillPending.has(String(id))) continue;
      const info = infos.get(String(id));
      if (info?.threadId) {
        updateThreadMeta(threads, info.threadId, accept
          ? { status: "resolved", statusNote: undefined }
          : { status: "open", assignee: "me", statusNote: "You rejected the AI's change." });
      }
      infos.delete(String(id));
    }
  });
}
