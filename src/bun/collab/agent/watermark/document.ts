import { EditorState } from "prosemirror-state";
import { updateYFragment } from "y-prosemirror";
import { COLLAB_FRAGMENT } from "../../../../shared/collab/protocol";
import { protectedLiteralRanges } from "../../../../shared/ai-text-protection";
import type { CollabSession } from "../../registry";
import { blockAt, hasSuggestionMarks, readDoc } from "../doc-model";
import { cleanUnicode, type UnicodeEdit } from "./unicode";

/** Explicit whole-document cleanup. One reversible Yjs transaction; no AI rewrite. */
export function cleanDocumentWatermarks(session: CollabSession, origin: unknown) {
  const doc = readDoc(session);
  const edits: UnicodeEdit[] = [];
  let scanned = 0, skipped = 0, removed = 0, replaced = 0;
  doc.descendants((node, pos) => {
    if (node.type.spec.code || node.type.name === "codeBlock") { skipped++; return false; }
    if (!node.isTextblock) return true;
    if (hasSuggestionMarks(node)) { skipped++; return false; }
    scanned++;
    // Retain inline offsets and context across formatting boundaries. Mask atoms,
    // code and literal markup instead of sending their contents through cleaning.
    let text = "";
    node.forEach(child => {
      text += child.isText && !child.marks.some(mark => mark.type.name === "code")
        ? child.text! : "\uFFFC".repeat(child.nodeSize);
    });
    for (const range of protectedLiteralRanges(text).reverse()) {
      text = text.slice(0, range.from) + "\uFFFC".repeat(range.to - range.from) + text.slice(range.to);
    }
    const result = cleanUnicode(text);
    removed += result.removed;
    replaced += result.replaced;
    edits.push(...result.edits.map(edit => ({ ...edit, from: pos + 1 + edit.from, to: pos + 1 + edit.to })));
    return false;
  });
  const blockIds = [...new Set(edits.map(edit => blockAt(doc, edit.from)?.id).filter((id): id is string => !!id))];
  const tr = EditorState.create({ schema: session.schema, doc }).tr;
  for (const edit of edits.reverse()) {
    if (edit.insert) tr.replaceWith(edit.from, edit.to, session.schema.text(edit.insert, doc.nodeAt(edit.from)?.marks));
    else tr.delete(edit.from, edit.to);
  }
  if (tr.docChanged) session.ydoc.transact(() => {
    updateYFragment(session.ydoc, session.ydoc.getXmlFragment(COLLAB_FRAGMENT), tr.doc, { mapping: new Map(), isOMark: new Map() });
  }, origin);
  return { scanned, skipped, removed, replaced, blockIds };
}
