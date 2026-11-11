/** Place annotations in document order, keeping close anchors from overlapping. */
export function packMarginCards(items: Array<{ key: string; anchor: number; height: number }>, gap = 12) {
  let bottom = 0;
  return items.map(item => {
    const top = Math.max(0, item.anchor - 18, bottom);
    bottom = top + item.height + gap;
    return { ...item, top };
  });
}
/** The range commands use inclusive node starts, whereas hunks have an exclusive end. */
export function hunkDecisionRange(hunk: { from: number; to: number }) {
  return { from: hunk.from, to: Math.max(hunk.from, hunk.to - 1) };
}
