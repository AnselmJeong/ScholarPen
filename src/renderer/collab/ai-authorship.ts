import { createExtension } from "@blocknote/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import type { Mapping, Step } from "prosemirror-transform";
import { AI_AUTHORED_MARK, AI_AUTHORED_META } from "../../shared/collab/ai-authorship";

const key = new PluginKey("scholarpen-ai-authorship");
const SUGGESTION_INSERT = "insertion";

type Range = { from: number; to: number };

/** Ranges of the final document that the transactions' own steps wrote inline (typed, pasted inline, IME) or marked as a suggested insertion. */
function touchedRanges(transactions: readonly Transaction[]) {
  const ranges: Array<Range & { kind: "typed" | "suggested" }> = [];
  transactions.forEach((tr, trIndex) => {
    // Remote changes (other peers, Bun's AI) carry their own marks; AI writes in this editor say so.
    if ((tr.getMeta("y-sync$") as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin) return;
    if (tr.getMeta(AI_AUTHORED_META) || tr.getMeta(key)) return;
    const later = (stepIndex: number, range: Range): Range | null => {
      const maps: Mapping[] = [tr.mapping.slice(stepIndex + 1), ...transactions.slice(trIndex + 1).map((next) => next.mapping)];
      let { from, to } = range;
      for (const map of maps) { from = map.map(from, 1); to = map.map(to, -1); }
      return from < to ? { from, to } : null;
    };
    tr.steps.forEach((step: Step, stepIndex) => {
      const json = step.toJSON() as { stepType?: string; from?: number; mark?: { type?: string } };
      const slice = (step as unknown as { slice?: { size: number; content: { descendants(f: (node: { isBlock: boolean }) => boolean | void): void } } }).slice;
      if (json.stepType === "replace" && slice && slice.size > 0 && typeof json.from === "number") {
        // Only inline text: moving, restoring or reconciling whole blocks keeps their authorship.
        let blocks = false;
        slice.content.descendants((node) => { if (node.isBlock) blocks = true; return !blocks; });
        if (blocks) return;
        const range = later(stepIndex, { from: json.from, to: json.from + slice.size });
        if (range) ranges.push({ ...range, kind: "typed" });
      } else if (json.stepType === "addMark" && json.mark?.type === SUGGESTION_INSERT && typeof json.from === "number") {
        const range = later(stepIndex, { from: json.from, to: (json as { to?: number }).to ?? json.from });
        if (range) ranges.push({ ...range, kind: "suggested" });
      }
    });
  });
  return ranges;
}

/**
 * Keeps the AI-authorship mark true to who wrote the words: text the author
 * types (over AI text too) loses it; text that arrives as a suggested
 * insertion in this editor (BlockNote's own AI menu, inline AI suggestions)
 * gains it, so it stays marked once accepted.
 */
export function authorshipTransaction(state: EditorState, transactions: readonly Transaction[]): Transaction | null {
  const markType = state.schema.marks[AI_AUTHORED_MARK];
  if (!markType || !transactions.some((tr) => tr.docChanged)) return null;
  const ranges = touchedRanges(transactions);
  if (!ranges.length) return null;
  const tr = state.tr;
  const size = state.doc.content.size;
  for (const range of ranges) {
    const from = Math.max(0, range.from);
    const to = Math.min(size, range.to);
    if (from >= to) continue;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) return true;
      const start = Math.max(from, pos);
      const end = Math.min(to, pos + node.nodeSize);
      const suggested = node.marks.some((mark) => mark.type.name === SUGGESTION_INSERT);
      const authored = markType.isInSet(node.marks);
      if (suggested && !authored) tr.addMark(start, end, markType.create());
      else if (!suggested && authored && range.kind === "typed") tr.removeMark(start, end, markType);
      return false;
    });
  }
  if (!tr.docChanged) return null;
  return tr.setMeta(key, true).setMeta("addToHistory", false);
}

export const AIAuthorshipExtension = createExtension(() => ({
  key: "aiAuthorship",
  prosemirrorPlugins: [new Plugin({
    key,
    appendTransaction: (transactions, _oldState, newState) => authorshipTransaction(newState, transactions),
  })],
} as const));
