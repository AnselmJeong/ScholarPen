import type { Mark, MarkType, Node as PMNode } from "prosemirror-model";
import { EditorState, type Transaction } from "prosemirror-state";
import { Transform } from "prosemirror-transform";
import { applySuggestion, applySuggestions, revertSuggestion, revertSuggestions } from "@handlewithcare/prosemirror-suggest-changes";
import { settlePendingNodes } from "./pending-nodes";

/**
 * Keeps (`accept`) or reverts the suggestions of change set `id` (every one
 * when undefined), optionally only those starting inside [from, to] as
 * prosemirror-suggest-changes counts a range. Returns true when anything changed.
 *
 * Suggested text is resolved inside its own paragraph. The library would end
 * a struck stretch that reaches a paragraph's end, or that holds three pieces
 * in a row (plain text, an italic run, a struck citation), at a struck start
 * of the next paragraph in the same change set and merge the two paragraphs;
 * AI suggestions never span paragraphs. Whole blocks added or removed are
 * still resolved by the library, and citations or equations standing in as
 * text (`pending-nodes.ts`) become nodes again.
 */
export function resolveSuggestions(tr: Transform, accept: boolean, id?: string | number, range?: { from: number; to: number }): boolean {
  const steps = tr.steps.length;
  const { insertion, deletion } = tr.doc.type.schema.marks;
  if (insertion && deletion) resolveInline(tr, accept ? deletion : insertion, accept ? insertion : deletion, id, range);

  // What is left (block-level suggestions, modifications) goes to the library.
  const mapped = range && { from: tr.mapping.map(range.from, -1), to: tr.mapping.map(range.to, 1) };
  const command = id === undefined
    ? (accept ? applySuggestions : revertSuggestions)
    : (accept ? applySuggestion : revertSuggestion)(id, mapped?.from, mapped?.to);
  command(EditorState.create({ schema: tr.doc.type.schema, doc: tr.doc }), (library: Transaction) => {
    for (const step of library.steps) tr.step(step);
  });

  settlePendingNodes(tr);
  return tr.steps.length > steps;
}

function resolveInline(tr: Transform, removed: MarkType, dropped: MarkType, id: string | number | undefined, range?: { from: number; to: number }) {
  const ofSet = (marks: readonly Mark[], type: MarkType) => marks.find((mark) => mark.type === type && (id === undefined || mark.attrs.id === id));
  const runs: Array<{ from: number; to: number }> = [];
  const unmarked: Array<{ from: number; to: number; mark: Mark }> = [];
  tr.doc.descendants((node: PMNode, pos: number) => {
    if (range && pos > range.to) return false;
    if (!node.isInline) return true;
    if (range && pos < range.from) return false;
    const gone = ofSet(node.marks, removed);
    const kept = gone ? undefined : ofSet(node.marks, dropped);
    if (gone) {
      // Contiguous pieces of one paragraph form one run; a paragraph boundary always ends it.
      const last = runs.at(-1);
      if (last && last.to === pos) last.to = pos + node.nodeSize;
      else runs.push({ from: pos, to: pos + node.nodeSize });
    } else if (kept) {
      unmarked.push({ from: pos, to: pos + node.nodeSize, mark: kept });
    }
    return false;
  });
  // Removing marks moves nothing; deleting from the end keeps earlier positions valid.
  for (const item of unmarked) tr.removeMark(item.from, item.to, item.mark);
  for (const run of runs.reverse()) {
    // As the library does: a run between two spaces takes one of them along.
    const doc = tr.doc;
    const before = run.from > 0 ? doc.textBetween(run.from - 1, run.from, "x", "x") : "";
    const after = run.to < doc.content.size ? doc.textBetween(run.to, run.to + 1, "x", "x") : "";
    tr.delete(run.from, run.to + (before === " " && after === " " ? 1 : 0));
  }
}

/** `doc` with every suggestion reverted, as the JSON snapshot, export and history see it. */
export function revertedDoc(doc: PMNode): PMNode {
  const tr = new Transform(doc);
  resolveSuggestions(tr, false);
  return tr.doc;
}
