import type { BlockNoteEditor } from "@blocknote/core";
import { docToBlocks } from "@blocknote/core";
import { EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import type * as Y from "yjs";
import type { ChangeSetInfo } from "../../shared/collab/change-sets";
import { applySuggestion, revertSuggestion, revertSuggestions } from "@handlewithcare/prosemirror-suggest-changes";

const SUGGESTION_MARKS = ["insertion", "deletion", "modification"];

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

/** One paragraph's part of a change set. */
export interface ChangeSetParagraph {
  blockId: string | null;
  from: number;
  to: number;
  inserted: string;
  deleted: string;
}

/** Everything one AI request changed, waiting for the author's decision. */
export interface PendingChangeSet {
  id: string | number;
  info: ChangeSetInfo | null;
  from: number;
  paragraphs: ChangeSetParagraph[];
}

export function listChangeSets(doc: PMNode, infos?: Y.Map<ChangeSetInfo>): PendingChangeSet[] {
  const sets = new Map<string | number, PendingChangeSet>();
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
      const set = sets.get(id) ?? { id, info: infos?.get(String(id)) ?? null, from: pos, paragraphs: [] };
      set.from = Math.min(set.from, pos);
      let paragraph = set.paragraphs.find((item) => item.blockId === blockId);
      if (!paragraph) {
        paragraph = { blockId, from: pos, to: pos + node.nodeSize, inserted: "", deleted: "" };
        set.paragraphs.push(paragraph);
      }
      paragraph.from = Math.min(paragraph.from, pos);
      paragraph.to = Math.max(paragraph.to, pos + node.nodeSize);
      const text = node.isText ? node.text ?? "" : `[${node.type.name}]`;
      if (mark.type.name === "insertion") paragraph.inserted += text;
      else paragraph.deleted += (paragraph.deleted && !paragraph.deleted.endsWith(" ") ? " … " : "") + text;
      sets.set(id, set);
    }
    return true;
  });
  return [...sets.values()].sort((a, b) => a.from - b.from);
}

/**
 * Accepts or rejects a whole change set, or only its part inside [from, to]
 * (one paragraph). Returns true when anything changed.
 */
export function resolveChangeSet(
  editor: BlockNoteEditor<any, any, any>,
  id: string | number,
  accept: boolean,
  range?: { from: number; to: number },
) {
  const view = editor.prosemirrorView;
  if (!view) return false;
  const command = accept ? applySuggestion(id, range?.from, range?.to) : revertSuggestion(id, range?.from, range?.to);
  return command(view.state, view.dispatch);
}

/** Accepts or rejects every pending change set. */
export function resolveAllChangeSets(editor: BlockNoteEditor<any, any, any>, accept: boolean) {
  const view = editor.prosemirrorView;
  if (!view) return [];
  const ids = listChangeSets(view.state.doc).map((set) => set.id);
  return ids.filter((id) => resolveChangeSet(editor, id, accept));
}
