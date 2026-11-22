import type { Node as PMNode } from "prosemirror-model";
import { leafText } from "../../shared/collab/schema-spec";
import { growToSentences, type Region } from "../../shared/collab/sentences";

/**
 * One reviewable change: the removed and added text of one AI request (one
 * suggestion id) inside one sentence of a paragraph, or several sentences
 * when the change joins or splits them. The author keeps or reverts it as
 * "this sentence, now that sentence", never as two unrelated words.
 */
export interface SuggestionHunk {
  /** Suggestion id of the change set the hunk belongs to. */
  id: string | number;
  blockId: string | null;
  /** From the first to the last suggested text of the change. */
  from: number;
  to: number;
  deleted: string;
  inserted: string;
  /** Text positions of the inserted runs, for per-word reveal. */
  insertions: Array<{ from: number; to: number }>;
  deletions: Array<{ from: number; to: number }>;
  /** The sentence(s) as they read without the change, and with it; "" for an added or a removed sentence. */
  before: string;
  after: string;
  /** Document range of those sentences, both versions included. */
  span: { from: number; to: number };
}

const inlineText = (node: PMNode) => node.isText ? node.text ?? "" : leafText(node) || `[${node.type.name}]`;

/** One version of a paragraph's text, with the document position before and after each character. */
interface View { text: string; before: number[]; after: number[] }

function append(view: View, node: PMNode, pos: number, text: string) {
  for (let i = 0; i < text.length; i++) {
    view.before.push(node.isText ? pos + i : pos);
    view.after.push(node.isText ? pos + i + 1 : pos + node.nodeSize);
  }
  view.text += text;
}

type RawHunk = Omit<SuggestionHunk, "before" | "after" | "span"> & { region: Region };

/** The changes of one textblock whose inline content starts at `start`, one per sentence. */
function textblockHunks(block: PMNode, start: number, blockId: string | null): SuggestionHunk[] {
  const old: View = { text: "", before: [], after: [] };
  const next: View = { text: "", before: [], after: [] };
  const raw: RawHunk[] = [];
  let current: RawHunk | null = null;
  block.forEach((child, offset) => {
    const pos = start + offset;
    const end = pos + child.nodeSize;
    const text = inlineText(child);
    const mark = child.marks.find((item) => item.type.name === "insertion" || item.type.name === "deletion");
    const o = old.text.length;
    const n = next.text.length;
    if (mark?.type.name !== "insertion") append(old, child, pos, text);
    if (mark?.type.name !== "deletion") append(next, child, pos, text);
    if (!mark) {
      current = null;
      return;
    }
    const id = mark.attrs.id as string | number;
    if (!current || current.id !== id) {
      current = { id, blockId, from: pos, to: end, deleted: "", inserted: "", insertions: [], deletions: [], region: { from: o, to: o, nf: n, ne: n } };
      raw.push(current);
    }
    current.to = end;
    const ranges = mark.type.name === "insertion" ? current.insertions : current.deletions;
    const last = ranges.at(-1);
    if (last && last.to === pos) last.to = end;
    else ranges.push({ from: pos, to: end });
    if (mark.type.name === "insertion") current.inserted += text;
    else current.deleted += text;
    current.region.to = old.text.length;
    current.region.ne = next.text.length;
  });
  if (!raw.length) return [];

  const contentEnd = start + block.content.size;
  const startOf = (view: View, k: number) => k < view.before.length ? view.before[k] : contentEnd;
  const endOf = (view: View, k: number) => k > 0 ? view.after[k - 1] : start;
  // Only changes of one request join, so each can still be kept or reverted on its own.
  return growToSentences(raw.map((hunk) => hunk.region), old.text, next.text, (a, b) => raw[a].id === raw[b].id).map((group) => {
    const members = group.members.map((index) => raw[index]);
    const first = members[0];
    const lastMember = members.at(-1)!;
    const from = Math.min(first.from, group.to > group.from ? startOf(old, group.from) : first.from,
      group.ne > group.nf ? startOf(next, group.nf) : first.from);
    const to = Math.max(lastMember.to, group.to > group.from ? endOf(old, group.to) : lastMember.to,
      group.ne > group.nf ? endOf(next, group.ne) : lastMember.to);
    return {
      id: first.id,
      blockId,
      from: first.from,
      to: lastMember.to,
      deleted: members.map((hunk) => hunk.deleted).join(""),
      inserted: members.map((hunk) => hunk.inserted).join(""),
      insertions: members.flatMap((hunk) => hunk.insertions),
      deletions: members.flatMap((hunk) => hunk.deletions),
      before: old.text.slice(group.from, group.to).trim(),
      after: next.text.slice(group.nf, group.ne).trim(),
      span: { from, to },
    };
  });
}

/** Every pending change in document order, one per changed sentence. */
export function listHunks(doc: PMNode): SuggestionHunk[] {
  const hunks: SuggestionHunk[] = [];
  let blockId: string | null = null;
  doc.descendants((node, pos) => {
    if (node.type.name === "blockContainer") {
      blockId = node.attrs.id ?? null;
      return true;
    }
    if (node.isTextblock) {
      hunks.push(...textblockHunks(node, pos + 1, blockId));
      return false;
    }
    return !node.isInline;
  });
  return hunks;
}

/** Identity of a hunk's content, stable while nobody edits it. */
export function hunkSignature(hunk: SuggestionHunk) {
  return `${hunk.id}\u0000${hunk.blockId}\u0000${hunk.deleted}\u0000${hunk.inserted}`;
}
