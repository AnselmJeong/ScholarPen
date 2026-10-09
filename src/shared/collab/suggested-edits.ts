import type { Node as PMNode } from "prosemirror-model";
import { diffHunks, singleHunk, type Hunk } from "./text-diff";

/**
 * Word-level hunks for light edits; a rewrite that touches most of the text
 * becomes one replaced span, which reads better than a patchwork of words.
 */
export function readableHunks(original: string, revised: string): Hunk[] {
  const hunks = diffHunks(original, revised);
  if (hunks.length <= 3) return hunks;
  const touched = hunks.reduce((sum, hunk) => sum + (hunk.to - hunk.from), 0);
  if (touched < original.length * 0.4) return hunks;
  const whole = singleHunk(original, revised);
  return whole ? [whole] : [];
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
