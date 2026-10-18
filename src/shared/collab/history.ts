import type { Node as PMNode } from "prosemirror-model";
import { diffHunks } from "./text-diff";

/**
 * Version history of one document. Bun records every change to the shared
 * Y.Doc as checkpoints in `.scholarpen/history/<document>/`; this module holds
 * the types both sides use and the pure helpers that compare two versions.
 */

export type HistoryEntryKind = "start" | "author" | "ai" | "system" | "outside" | "restore";

export interface HistoryStats {
  /** Words added and removed in the accepted manuscript. */
  added: number;
  removed: number;
  /** Paragraphs (blocks) whose content changed, appeared or disappeared. */
  blocks: number;
}

export interface HistoryEntry {
  id: string;
  kind: HistoryEntryKind;
  startedAt: number;
  endedAt: number;
  /** What happened, when known: the AI request, "Accepted AI suggestions", the restored version. */
  label?: string;
  /** A name the author gave this version. Named versions are never thinned. */
  name?: string;
  /** How many checkpoints were thinned into this one. */
  merged?: number;
  stats: HistoryStats;
}

export interface HistoryVersion {
  entryId: string;
  /** ProseMirror JSON of the document after the entry, with pending AI suggestions left out. */
  doc: unknown;
}

export interface HistoryBlock {
  id: string;
  /** Content node type: paragraph, heading, … */
  type: string;
  text: string;
  /** Content without comment marks, to tell formatting changes from none. */
  fingerprint: string;
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

export function countWords(text: string) {
  return text.match(WORD)?.length ?? 0;
}

function withoutCommentMarks(json: any): any {
  if (Array.isArray(json)) return json.map(withoutCommentMarks);
  if (!json || typeof json !== "object") return json;
  const out: any = { ...json };
  if (Array.isArray(out.marks)) {
    out.marks = out.marks.filter((mark: any) => mark?.type !== "comment");
    if (out.marks.length === 0) delete out.marks;
  }
  if (out.content) out.content = withoutCommentMarks(out.content);
  return out;
}

function leafText(node: PMNode) {
  const leaf = node.type.spec.leafText;
  return leaf ? leaf(node) : "";
}

/** Every block of a BlockNote ProseMirror document in reading order, nested blocks included. */
export function blockTexts(doc: PMNode): HistoryBlock[] {
  const blocks: HistoryBlock[] = [];
  doc.descendants((node) => {
    if (node.type.name !== "blockContainer") return true;
    const content = node.firstChild;
    if (!content) return true;
    blocks.push({
      id: String(node.attrs.id),
      type: content.type.name,
      text: content.content.size > 0 ? content.textBetween(0, content.content.size, "\n", leafText) : "",
      fingerprint: JSON.stringify(withoutCommentMarks(content.toJSON())),
    });
    return true;
  });
  return blocks;
}

export function wordChanges(before: string, after: string) {
  let added = 0;
  let removed = 0;
  for (const hunk of diffHunks(before, after)) {
    removed += countWords(before.slice(hunk.from, hunk.to));
    added += countWords(hunk.insert);
  }
  return { added, removed };
}

export function historyStats(before: HistoryBlock[], after: HistoryBlock[]): HistoryStats {
  const previous = new Map(before.map((block) => [block.id, block]));
  const stats: HistoryStats = { added: 0, removed: 0, blocks: 0 };
  for (const block of after) {
    const old = previous.get(block.id);
    previous.delete(block.id);
    if (old?.fingerprint === block.fingerprint) continue;
    stats.blocks++;
    const words = wordChanges(old?.text ?? "", block.text);
    stats.added += words.added;
    stats.removed += words.removed;
  }
  for (const old of previous.values()) {
    stats.blocks++;
    stats.removed += countWords(old.text);
  }
  return stats;
}

export type DiffPart = { text: string; op: "same" | "add" | "remove" };

export type DiffRow =
  | { kind: "same"; id: string; type: string; text: string }
  /** Same block in both versions with different content; `older` is the block on the older side. */
  | { kind: "changed"; id: string; type: string; parts: DiffPart[]; older: string }
  /** Only in the newer version. */
  | { kind: "added"; id: string; type: string; text: string }
  /** Only in the older version. */
  | { kind: "removed"; id: string; type: string; text: string };

export function diffParts(older: string, newer: string): DiffPart[] {
  const parts: DiffPart[] = [];
  const push = (text: string, op: DiffPart["op"]) => {
    if (!text) return;
    const last = parts.at(-1);
    if (last?.op === op) last.text += text;
    else parts.push({ text, op });
  };
  let at = 0;
  for (const hunk of diffHunks(older, newer)) {
    push(older.slice(at, hunk.from), "same");
    push(older.slice(hunk.from, hunk.to), "remove");
    push(hunk.insert, "add");
    at = hunk.to;
  }
  push(older.slice(at), "same");
  return parts;
}

/**
 * The ids of `ids` that keep their order in `target`: the longest common
 * subsequence of two lists of unique ids, via a longest increasing subsequence.
 */
export function commonIds(ids: string[], target: string[]): Set<string> {
  const position = new Map(target.map((id, index) => [id, index]));
  const seq = ids.filter((id) => position.has(id));
  const tails: number[] = [];
  const tailIndex: number[] = [];
  const previous = new Array<number>(seq.length).fill(-1);
  seq.forEach((id, index) => {
    const value = position.get(id)!;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (tails[mid] < value) low = mid + 1;
      else high = mid;
    }
    tails[low] = value;
    tailIndex[low] = index;
    previous[index] = low > 0 ? tailIndex[low - 1] : -1;
  });
  const kept = new Set<string>();
  for (let index = tails.length ? tailIndex[tails.length - 1] : -1; index >= 0; index = previous[index]) {
    kept.add(seq[index]);
  }
  return kept;
}

/** Block-by-block comparison from an older version to a newer one, in the newer version's order. */
export function diffBlocks(older: HistoryBlock[], newer: HistoryBlock[]): DiffRow[] {
  const kept = commonIds(older.map((block) => block.id), newer.map((block) => block.id));
  const olderById = new Map(older.map((block) => [block.id, block]));
  const rows: DiffRow[] = [];
  let olderAt = 0;
  const flushRemoved = (untilId: string | null) => {
    while (olderAt < older.length && older[olderAt].id !== untilId) {
      const block = older[olderAt++];
      if (!kept.has(block.id)) rows.push({ kind: "removed", id: block.id, type: block.type, text: block.text });
    }
    if (untilId !== null) olderAt++;
  };
  for (const block of newer) {
    if (!kept.has(block.id)) {
      rows.push({ kind: "added", id: block.id, type: block.type, text: block.text });
      continue;
    }
    flushRemoved(block.id);
    const old = olderById.get(block.id)!;
    rows.push(old.fingerprint === block.fingerprint
      ? { kind: "same", id: block.id, type: block.type, text: block.text }
      : { kind: "changed", id: block.id, type: block.type, parts: diffParts(old.text, block.text), older: old.text });
  }
  flushRemoved(null);
  return rows;
}

/** Timeline rows: consecutive plain author checkpoints close in time collapse into one editing session. */
export interface HistoryGroup {
  entries: HistoryEntry[];
  /** The checkpoint the group stands for (its newest). */
  head: HistoryEntry;
  session: boolean;
}

const SESSION_GAP_MS = 10 * 60_000;

function isPlainAuthor(entry: HistoryEntry) {
  return entry.kind === "author" && !entry.name && !entry.label;
}

/** Groups entries listed oldest first; groups come back newest first. */
export function groupHistory(entries: HistoryEntry[]): HistoryGroup[] {
  const groups: HistoryGroup[] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last && last.session && isPlainAuthor(entry) && entry.startedAt - last.head.endedAt < SESSION_GAP_MS) {
      last.entries.push(entry);
      last.head = entry;
      continue;
    }
    groups.push({ entries: [entry], head: entry, session: isPlainAuthor(entry) });
  }
  return groups.reverse();
}

export function sumStats(entries: HistoryEntry[]): HistoryStats {
  return entries.reduce((sum, entry) => ({
    added: sum.added + entry.stats.added,
    removed: sum.removed + entry.stats.removed,
    blocks: sum.blocks + entry.stats.blocks,
  }), { added: 0, removed: 0, blocks: 0 });
}
