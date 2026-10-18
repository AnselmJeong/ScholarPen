import type { HistoryEntry } from "../../../shared/collab/history";

export interface StoredEntry extends HistoryEntry {
  /** Number of the checkpoint file that holds this entry's changes. */
  seq: number;
  /** The accepted manuscript did not change (comment anchors, pending suggestions, bookkeeping). */
  hidden?: boolean;
}

/** Inclusive range of entries to fold into one. */
export interface MergeRun { from: number; to: number }

const HOUR = 60 * 60_000;
/** Every checkpoint is kept this long, then one per hour, and after two weeks one per day. */
export const KEEP_ALL_MS = 48 * HOUR;
export const KEEP_HOURLY_MS = 14 * 24 * HOUR;

/** AI edits, restores, accepted suggestions and named versions keep their own place in the timeline. */
function isProtected(entry: StoredEntry) {
  return !!entry.name || !!entry.label || !["author", "system", "outside"].includes(entry.kind);
}

function bucket(entry: StoredEntry, now: number) {
  const age = now - entry.endedAt;
  if (age < KEEP_ALL_MS) return null;
  const at = new Date(entry.endedAt);
  const day = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
  return age < KEEP_HOURLY_MS ? `${day}-${at.getHours()}` : day;
}

/**
 * Which entries to fold together. Hidden entries always fold into the entry
 * after them (they changed nothing a reader sees); old plain checkpoints fold
 * into one per hour or day. Folding keeps the state at the end of each run,
 * so the moment before every protected entry survives.
 */
export function planThinning(entries: StoredEntry[], now: number): MergeRun[] {
  const groups: Array<{ from: number; to: number; head: StoredEntry }> = [];
  let from = 0;
  entries.forEach((entry, index) => {
    if (entry.hidden && index < entries.length - 1) return;
    groups.push({ from, to: index, head: entry });
    from = index + 1;
  });

  const runs: MergeRun[] = [];
  const emit = (a: number, b: number) => { if (b > a) runs.push({ from: a, to: b }); };
  let run: typeof groups = [];
  let runKey: string | null = null;
  const flush = () => {
    if (run.length) emit(run[0].from, run[run.length - 1].to);
    run = [];
    runKey = null;
  };
  for (const group of groups) {
    const key = group.head.hidden || isProtected(group.head) ? null : bucket(group.head, now);
    if (key === null) {
      flush();
      emit(group.from, group.to);
      continue;
    }
    if (runKey !== null && runKey !== key) flush();
    run.push(group);
    runKey = key;
  }
  flush();
  return runs;
}

/** The entry that stands for a folded run; it keeps the id of the newest visible member. */
export function mergeEntries(members: StoredEntry[], seq: number): StoredEntry {
  const visible = members.filter((entry) => !entry.hidden);
  if (visible.length <= 1) {
    const head = visible[0] ?? members[members.length - 1];
    return { ...head, seq, hidden: visible.length === 0 ? true : undefined };
  }
  const last = visible[visible.length - 1];
  return {
    id: last.id,
    seq,
    kind: visible.some((entry) => entry.kind === "author") ? "author" : last.kind,
    startedAt: visible[0].startedAt,
    endedAt: last.endedAt,
    merged: visible.reduce((count, entry) => count + (entry.merged ?? 1), 0),
    stats: visible.reduce((sum, entry) => ({
      added: sum.added + entry.stats.added,
      removed: sum.removed + entry.stats.removed,
      blocks: sum.blocks + entry.stats.blocks,
    }), { added: 0, removed: 0, blocks: 0 }),
  };
}
