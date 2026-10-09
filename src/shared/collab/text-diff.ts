/** A change to `original`: replace original[from, to) with `insert`. */
export interface Hunk {
  from: number;
  to: number;
  insert: string;
}

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const MAX_LCS_CELLS = 4_000_000;

function tokenize(text: string) {
  return text.match(TOKEN) ?? [];
}

/** The single changed region between two strings (common prefix and suffix trimmed). */
export function singleHunk(original: string, revised: string): Hunk | null {
  if (original === revised) return null;
  let start = 0;
  const max = Math.min(original.length, revised.length);
  while (start < max && original[start] === revised[start]) start++;
  let endO = original.length;
  let endR = revised.length;
  while (endO > start && endR > start && original[endO - 1] === revised[endR - 1]) {
    endO--;
    endR--;
  }
  return { from: start, to: endO, insert: revised.slice(start, endR) };
}

/** Word-level hunks that turn `original` into `revised`, in document order. */
export function diffHunks(original: string, revised: string): Hunk[] {
  if (original === revised) return [];
  const a = tokenize(original);
  const b = tokenize(revised);
  if (a.length * b.length > MAX_LCS_CELLS) {
    const hunk = singleHunk(original, revised);
    return hunk ? [hunk] : [];
  }
  // LCS table over tokens, filled from the end so the walk below goes forward.
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let offset = 0;
  let open: Hunk | null = null;
  const close = () => {
    if (open) hunks.push(open);
    open = null;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close();
      offset += a[i].length;
      i++;
      j++;
    } else if (j < b.length && (i === a.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) {
      open ??= { from: offset, to: offset, insert: "" };
      open.insert += b[j];
      j++;
    } else {
      open ??= { from: offset, to: offset, insert: "" };
      offset += a[i].length;
      open.to = offset;
      i++;
    }
  }
  close();
  return hunks;
}

export function applyHunks(text: string, hunks: Hunk[]) {
  let output = "";
  let cursor = 0;
  for (const hunk of hunks) {
    output += text.slice(cursor, hunk.from) + hunk.insert;
    cursor = hunk.to;
  }
  return output + text.slice(cursor);
}

/**
 * Three-way merge of one text: `user` and `ai` both started from `base`.
 * Succeeds when the user's edit and the AI's edits touch different words;
 * returns null when they overlap.
 */
export function mergeText(base: string, user: string, ai: string): string | null {
  if (user === base) return ai;
  if (ai === base || ai === user) return user;
  const userHunks = diffHunks(base, user);
  const aiHunks = diffHunks(base, ai);
  const overlaps = (x: Hunk, y: Hunk) => x.from <= y.to && y.from <= x.to;
  if (aiHunks.some((hunk) => userHunks.some((own) => overlaps(hunk, own)))) return null;
  return applyHunks(base, [...userHunks, ...aiHunks].sort((x, y) => x.from - y.from));
}

/** Typo-sized edits: each changed word differs from the original by at most a few characters. */
export function isMinorEdit(original: string, hunks: Hunk[]) {
  if (hunks.length === 0 || hunks.length > 3) return false;
  let total = 0;
  for (const hunk of hunks) {
    const change = singleHunk(original.slice(hunk.from, hunk.to), hunk.insert);
    if (!change) continue;
    const size = Math.max(change.to - change.from, change.insert.length);
    if (size > 3) return false;
    total += size;
  }
  return total <= 8;
}
