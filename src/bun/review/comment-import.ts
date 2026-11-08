import type { ReviewComment, ReviewerProfile } from "../../shared/review-session/types";
/** Split only explicit numbered items; every original byte is covered by a source range. */
export function importComments(reviewer: ReviewerProfile): ReviewComment[] {
  const original = reviewer.original;
  const starts = [...original.matchAll(/^[ \t]*(?:(?:Comment|Major comment|Minor comment)\s*)?\d+[.)\]:][ \t]+/gim)].map(m => m.index!);
  const boundaries = [...new Set([0, ...starts, original.length])].sort((a, b) => a - b);
  const ranges = boundaries.slice(0, -1).map((start, i) => ({ start, end: boundaries[i + 1]! })).filter(r => r.end > r.start);
  if (ranges.length > 1 && !original.slice(ranges[0]!.start, ranges[0]!.end).trim()) { ranges[1]!.start = 0; ranges.shift(); }
  return ranges.map((range, i) => ({ id: `${reviewer.id}-C${String(i + 1).padStart(2, "0")}`, reviewerId: reviewer.id,
    parentId: reviewer.id, sourceStart: range.start, sourceEnd: range.end,
    original: original.slice(range.start, range.end), targets: [], severity: "major", source: "human" }));
}
