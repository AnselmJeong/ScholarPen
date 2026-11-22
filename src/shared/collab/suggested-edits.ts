import type { Mark, Node as PMNode } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import { diffHunks, singleHunk, type Hunk } from "./text-diff";
import { growToSentences, type Region } from "./sentences";
import { withAIAuthored } from "./ai-authorship";

/**
 * Word-level hunks for light edits; a rewrite that touches most of the text
 * becomes one replaced span, which reads better than a patchwork of words.
 * Used for edits that land directly, where nothing is shown to review.
 */
export function readableHunks(original: string, revised: string): Hunk[] {
  const hunks = diffHunks(original, revised);
  if (hunks.length <= 3) return hunks;
  const touched = hunks.reduce((sum, hunk) => sum + (hunk.to - hunk.from), 0);
  if (touched < original.length * 0.4) return hunks;
  const whole = singleHunk(original, revised);
  return whole ? [whole] : [];
}

/** Word-level hunks with their place in the revised text. */
function alignedRegions(original: string, revised: string): Region[] {
  let delta = 0;
  return diffHunks(original, revised).map((hunk) => {
    const nf = hunk.from + delta;
    delta += hunk.insert.length - (hunk.to - hunk.from);
    return { from: hunk.from, to: hunk.to, nf, ne: nf + hunk.insert.length };
  });
}

/**
 * Sentence-level hunks for suggestions the author reviews: each one replaces
 * whole sentences ("original sentence → revised sentence"), or adds or removes
 * whole sentences, so a redline never pairs two unrelated words.
 */
export function sentenceHunks(original: string, revised: string): Hunk[] {
  const regions = alignedRegions(original, revised);
  if (!regions.length) return [];
  return growToSentences(regions, original, revised)
    .map((group) => ({ from: group.from, to: group.to, insert: revised.slice(group.nf, group.ne) }))
    .filter((hunk) => original.slice(hunk.from, hunk.to) !== hunk.insert);
}

/** Ranges of `revised` holding words that are not in `original`. */
export function newTextRanges(original: string, revised: string): Array<{ from: number; to: number }> {
  return alignedRegions(original, revised).filter((region) => region.ne > region.nf).map((region) => ({ from: region.nf, to: region.ne }));
}

/**
 * Inline content that replaces doc[from, from + original.length), a stretch of
 * plain text that reads `original`, so it reads `revised`. Words the edit
 * keeps are copied with their own marks (formatting, earlier authorship);
 * only new words are written with `marks` and the AI-authorship mark.
 */
export function revisedInline(doc: PMNode, from: number, original: string, revised: string, marks: readonly Mark[]): PMNode[] {
  const schema = doc.type.schema;
  const nodes: PMNode[] = [];
  const copy = (start: number, end: number) => {
    if (end <= start) return;
    doc.nodesBetween(from + start, from + end, (node, pos) => {
      if (!node.isText) return true;
      const a = Math.max(from + start, pos) - pos;
      const b = Math.min(from + end, pos + node.nodeSize) - pos;
      if (b > a) nodes.push(node.cut(a, b));
      return false;
    });
  };
  const written = (text: string) => { if (text) nodes.push(schema.text(text, withAIAuthored(schema, marks))); };
  let cursor = 0;
  for (const hunk of diffHunks(original, revised)) {
    const kept = original.slice(cursor, hunk.from);
    // Spaces and punctuation between two new stretches belong to the AI's wording, not to the author's.
    if (cursor > 0 && !/[\p{L}\p{N}]/u.test(kept)) written(kept);
    else copy(cursor, hunk.from);
    written(hunk.insert);
    cursor = hunk.to;
  }
  copy(cursor, original.length);
  return nodes;
}

/**
 * Writes `content` in place of doc[from, to) as a tracked change: the old text
 * marked deleted and the new content right after it marked inserted, both
 * under suggestion `id`. Built directly rather than with
 * transformToSuggestionTransaction, which moves an insertion that ends a
 * paragraph into the next paragraph when that one opens with a deletion of the
 * same change set, as whole-sentence changes often do. The range must hold no
 * pending suggestion.
 */
export function suggestReplacement(tr: Transaction, from: number, to: number, content: readonly PMNode[], id: number | string) {
  const { deletion, insertion } = tr.doc.type.schema.marks;
  if (!deletion || !insertion) throw new Error("The schema has no suggestion marks.");
  if (to > from) tr.addMark(from, to, deletion.create({ id }));
  if (content.length) {
    const mark = insertion.create({ id });
    tr.insert(to, content.map((node) => node.mark(mark.addToSet(node.marks))));
  }
}

/** Next unused suggestion id in a document. */
export function nextSuggestionId(doc: PMNode) {
  let max = 0;
  doc.descendants((node) => {
    for (const mark of node.marks) {
      if (["insertion", "deletion", "modification"].includes(mark.type.name)) {
        const id = Number(mark.attrs.id);
        if (Number.isFinite(id)) max = Math.max(max, id);
      }
    }
    return true;
  });
  return max + 1;
}
