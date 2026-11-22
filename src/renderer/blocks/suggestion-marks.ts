import { BLOCK_LEVEL_SUGGESTION_GROUP, NON_FORMATTING_MARK_GROUP, createExtension } from "@blocknote/core";
import { Mark } from "@tiptap/core";
import { deletion, insertion, modification } from "@handlewithcare/prosemirror-suggest-changes";
import type { MarkSpec } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { PENDING_NODE_MARK, settlePendingNodes } from "../../shared/collab/pending-nodes";

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

/**
 * Text standing in for a citation, equation or cross-reference that a pending
 * suggestion removes or adds (`shared/collab/pending-nodes.ts`): y-prosemirror
 * keeps no marks on inline nodes, so the node travels as text in this mark.
 */
const PendingNodeMark = Mark.create({
  name: PENDING_NODE_MARK,
  inclusive: false,
  group: NON_FORMATTING_MARK_GROUP,
  addAttributes() { return { node: { default: "", renderHTML: () => ({}) } }; },
  extendMarkSchema(extension) {
    if (extension.name !== PENDING_NODE_MARK) return {};
    // Copied out of the editor it is plain text: the node only comes back through Keep or Revert.
    return { blocknoteIgnore: true, inclusive: false, toDOM: () => ["span", { class: "sp-pending-node" }, 0], parseDOM: [] };
  },
});

const settleKey = new PluginKey("scholarpen-pending-nodes");

/**
 * After this editor keeps or reverts a suggestion, a citation or equation it
 * removed (reverted) or added (kept) becomes a node again. Remote changes are
 * left to the peer that made them, so two peers never both rebuild one node.
 */
export function settlePendingNodesTransaction(state: EditorState, transactions: readonly Transaction[]): Transaction | null {
  // Keep and Revert take a suggestion mark off; typing never does, so it costs no walk over the document.
  const decided = transactions.some((tr) => !(tr.getMeta("y-sync$") as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin &&
    tr.steps.some((step) => {
      const json = step.toJSON() as { stepType?: string; mark?: { type?: string } };
      return json.stepType === "removeMark" && (json.mark?.type === "insertion" || json.mark?.type === "deletion");
    }));
  if (!decided) return null;
  const tr = state.tr;
  return settlePendingNodes(tr) ? tr.setMeta(settleKey, true) : null;
}

export const SUGGESTION_MARKS_KEY = "aiAttributionMarks";

/** Registered before xl-ai's AIExtension, which brings the same marks under this key but not the pendingNode mark. */
export const SuggestionMarksExtension = createExtension(() => ({
  key: SUGGESTION_MARKS_KEY,
  tiptapExtensions: [
    suggestionMark("insertion", insertion, { id: { default: null } }),
    suggestionMark("deletion", deletion, { id: { default: null } }),
    suggestionMark("modification", modification, {
      id: { default: null }, type: { default: null }, attrName: { default: null }, previousValue: { default: null }, newValue: { default: null },
    }),
    PendingNodeMark,
  ],
  prosemirrorPlugins: [new Plugin({
    key: settleKey,
    appendTransaction: (transactions, _oldState, newState) => settlePendingNodesTransaction(newState, transactions),
  })],
}));
