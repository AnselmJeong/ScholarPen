import { BLOCK_LEVEL_SUGGESTION_GROUP, NON_FORMATTING_MARK_GROUP, createExtension } from "@blocknote/core";
import { Mark } from "@tiptap/core";
import { deletion, insertion, modification } from "@handlewithcare/prosemirror-suggest-changes";
import type { MarkSpec } from "prosemirror-model";

/**
 * The tracked-change marks (`insertion` / `deletion` / `modification`) every
 * ScholarPen editor needs: AI suggestions, review proposals and the schema
 * shipped to Bun all use them. Since BlockNote 0.57 they are no longer in the
 * default schema (only xl-ai's AI extension brings them), so they are
 * registered here, under the AI extension's key: whichever comes first wins,
 * and the two define the same marks.
 */
function suggestionMark(name: "insertion" | "deletion" | "modification", spec: MarkSpec, attributes: Record<string, { default: unknown }>) {
  return Mark.create({
    name,
    inclusive: false,
    excludes: spec.excludes,
    // Allowed on block nodes too (whole-block suggestions), and inside plain-text blocks.
    group: `${BLOCK_LEVEL_SUGGESTION_GROUP} ${NON_FORMATTING_MARK_GROUP}`,
    addAttributes() { return attributes; },
    extendMarkSchema(extension) {
      if (extension.name !== name) return {};
      // Not a BlockNote style: it never appears in block JSON.
      return { blocknoteIgnore: true, inclusive: false, toDOM: spec.toDOM, parseDOM: spec.parseDOM };
    },
  });
}

export const SUGGESTION_MARKS_KEY = "aiAttributionMarks";

export const SuggestionMarksExtension = createExtension(() => ({
  key: SUGGESTION_MARKS_KEY,
  tiptapExtensions: [
    suggestionMark("insertion", insertion, { id: { default: null } }),
    suggestionMark("deletion", deletion, { id: { default: null } }),
    suggestionMark("modification", modification, {
      id: { default: null }, type: { default: null }, attrName: { default: null }, previousValue: { default: null }, newValue: { default: null },
    }),
  ],
}));
