import { Fragment, Slice, type Mark, type Node as PMNode, type Schema } from "prosemirror-model";

/**
 * `aiAuthored`: an invisible mark (a BlockNote style) on text ScholarPen AI
 * wrote. It is added wherever AI text enters the document, stays when the
 * author accepts a suggestion, and is dropped from text the author types over
 * it, so it reads "this wording came from the AI and the author kept it". The
 * editor shows it only when the author turns on "AI-written text".
 */
export const AI_AUTHORED_MARK = "aiAuthored";

/** The mark in this schema, or null where the schema predates it. */
export function aiAuthoredMark(schema: Schema): Mark | null {
  return schema.marks[AI_AUTHORED_MARK]?.create() ?? null;
}

/** `marks` plus the AI-authored mark (when the schema has it). */
export function withAIAuthored(schema: Schema, marks: readonly Mark[] = []): readonly Mark[] {
  const mark = aiAuthoredMark(schema);
  return mark ? mark.addToSet(marks) : marks;
}

/** Transaction meta: this transaction writes AI text, so its authorship marks stay. */
export const AI_AUTHORED_META = "scholarpen-ai-authored";

function blindFragment(fragment: Fragment): Fragment {
  const children: PMNode[] = [];
  fragment.forEach((child) => {
    if (child.isText) {
      const mark = child.type.schema.marks[AI_AUTHORED_MARK];
      children.push(mark ? child.mark(mark.removeFromSet(child.marks)) : child);
    } else {
      children.push(child.copy(blindFragment(child.content)));
    }
  });
  // fromArray joins neighbouring text nodes whose marks are now equal.
  return Fragment.fromArray(children);
}

/**
 * The node as AI editing sees it: authorship marks removed, so text written
 * partly by the AI and partly by the author is one run again. AI edits are
 * exchanged one text node at a time, and the mark must not split them.
 * Positions are unchanged.
 */
export function authorshipBlind(node: PMNode): PMNode {
  return node.isText ? node : node.copy(blindFragment(node.content));
}

export function authorshipBlindSlice(slice: Slice): Slice {
  return new Slice(blindFragment(slice.content), slice.openStart, slice.openEnd);
}
