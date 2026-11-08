import type { Node as PMNode } from "prosemirror-model";

/**
 * One reviewable change: a run of adjacent deletion/insertion text in one
 * paragraph that belongs to one AI request (one suggestion id). "Was …, now …"
 * is what the author keeps or reverts.
 */
export interface SuggestionHunk {
  /** Suggestion id of the change set the hunk belongs to. */
  id: string | number;
  blockId: string | null;
  from: number;
  to: number;
  deleted: string;
  inserted: string;
  /** Text positions of the inserted runs, for per-word reveal. */
  insertions: Array<{ from: number; to: number }>;
  deletions: Array<{ from: number; to: number }>;
}

const inlineText = (node: PMNode) => node.isText ? node.text ?? "" : node.type.name === "hardBreak" ? "\n" : `[${node.type.name}]`;

/** Every pending change in document order. */
export function listHunks(doc: PMNode): SuggestionHunk[] {
  const hunks: SuggestionHunk[] = [];
  let blockId: string | null = null;
  let current: SuggestionHunk | null = null;
  doc.descendants((node, pos) => {
    if (node.type.name === "blockContainer") {
      blockId = node.attrs.id ?? null;
      current = null;
      return true;
    }
    if (!node.isInline) {
      // A new textblock never continues the previous one's hunk.
      if (node.isTextblock) current = null;
      return true;
    }
    const mark = node.marks.find((item) => item.type.name === "insertion" || item.type.name === "deletion");
    if (!mark) {
      current = null;
      return false;
    }
    const id = mark.attrs.id as string | number;
    const end = pos + node.nodeSize;
    if (!current || current.id !== id || current.to !== pos || current.blockId !== blockId) {
      current = { id, blockId, from: pos, to: end, deleted: "", inserted: "", insertions: [], deletions: [] };
      hunks.push(current);
    }
    current.to = end;
    const ranges = mark.type.name === "insertion" ? current.insertions : current.deletions;
    const last = ranges.at(-1);
    if (last && last.to === pos) last.to = end;
    else ranges.push({ from: pos, to: end });
    if (mark.type.name === "insertion") current.inserted += inlineText(node);
    else current.deleted += inlineText(node);
    return false;
  });
  return hunks;
}

/** Identity of a hunk's content, stable while nobody edits it. */
export function hunkSignature(hunk: SuggestionHunk) {
  return `${hunk.id}\u0000${hunk.blockId}\u0000${hunk.deleted}\u0000${hunk.inserted}`;
}
