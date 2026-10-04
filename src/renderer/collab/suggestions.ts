import type { BlockNoteEditor } from "@blocknote/core";
import { docToBlocks } from "@blocknote/core";
import { EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { applySuggestion, revertSuggestion, revertSuggestions } from "@handlewithcare/prosemirror-suggest-changes";

const SUGGESTION_MARKS = ["insertion", "deletion", "modification"];

export interface PendingSuggestion {
  id: string | number;
  from: number;
  to: number;
  inserted: string;
  deleted: string;
  blockId: string | null;
}

function hasSuggestions(doc: PMNode) {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.marks.some((mark) => SUGGESTION_MARKS.includes(mark.type.name))) found = true;
    return !found;
  });
  return found;
}

/**
 * The document as the author has accepted it: pending AI suggestions are
 * left out (insertions dropped, deletions kept). This is what the JSON
 * snapshot, export and search see.
 */
export function acceptedDocument(editor: BlockNoteEditor<any, any, any>) {
  const state = editor.prosemirrorState;
  if (!hasSuggestions(state.doc)) return editor.document;
  let doc = state.doc;
  revertSuggestions(EditorState.create({ schema: state.schema, doc }), (tr) => { doc = tr.doc; });
  return docToBlocks(doc);
}

export function listSuggestions(doc: PMNode): PendingSuggestion[] {
  const byId = new Map<string | number, PendingSuggestion>();
  doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== "insertion" && mark.type.name !== "deletion") continue;
      const id = mark.attrs.id as string | number;
      let blockId: string | null = null;
      const $pos = doc.resolve(pos);
      for (let depth = $pos.depth; depth > 0; depth--) {
        if ($pos.node(depth).type.name === "blockContainer") { blockId = $pos.node(depth).attrs.id; break; }
      }
      const entry = byId.get(id) ?? { id, from: pos, to: pos + node.nodeSize, inserted: "", deleted: "", blockId };
      entry.from = Math.min(entry.from, pos);
      entry.to = Math.max(entry.to, pos + node.nodeSize);
      const text = node.isText ? node.text ?? "" : `[${node.type.name}]`;
      if (mark.type.name === "insertion") entry.inserted += text;
      else entry.deleted += text;
      byId.set(id, entry);
    }
    return true;
  });
  return [...byId.values()].sort((a, b) => a.from - b.from);
}

export function resolveSuggestion(editor: BlockNoteEditor<any, any, any>, id: string | number, accept: boolean) {
  const view = editor.prosemirrorView;
  if (!view) return false;
  return (accept ? applySuggestion(id) : revertSuggestion(id))(view.state, view.dispatch);
}

/** Accepts or rejects every suggestion that overlaps the range (the whole document by default). */
export function resolveAllSuggestions(editor: BlockNoteEditor<any, any, any>, accept: boolean, from = 0, to = Infinity) {
  const view = editor.prosemirrorView;
  if (!view) return 0;
  const ids = listSuggestions(view.state.doc)
    .filter((suggestion) => suggestion.from < to && from < suggestion.to)
    .map((suggestion) => suggestion.id);
  let resolved = 0;
  for (const id of ids) if (resolveSuggestion(editor, id, accept)) resolved++;
  return resolved;
}
