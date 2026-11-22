/**
 * Sentences as the unit an AI revision is shown and decided in: an original
 * sentence and the sentence that replaces it, or a sentence added or removed,
 * never single words swapped out of context.
 */

export interface Span { from: number; to: number }

/** A changed stretch: before[from, to) reads as after[nf, ne); the text between regions is identical in both. */
export interface Region { from: number; to: number; nf: number; ne: number }

/** Regions grown to whole sentences; `members` are the indexes of the regions each one covers. */
export interface SentenceRegion extends Region { members: number[] }

// Segments that end in one of these are not sentence ends ("Dr. Kim", "e.g. The", "Fig. 3B").
// "al." and "etc." often do end a sentence, so they are left to the segmenter.
const ABBREVIATION = /(?:^|[\s(\[])(?:Dr|Mr|Mrs|Ms|Prof|St|vs|cf|e\.g|i\.e|Fig|Figs|Eq|Eqs|Ref|Refs|approx|ca|Suppl|Tab|Vol)\.\s*$/i;

let segmenter: Intl.Segmenter | null | undefined;
function sentenceSegmenter() {
  if (segmenter === undefined) {
    try { segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" }); } catch { segmenter = null; }
  }
  return segmenter;
}

function rawSegments(text: string): Span[] {
  const intl = sentenceSegmenter();
  if (intl) return [...intl.segment(text)].map((part) => ({ from: part.index, to: part.index + part.segment.length }));
  const spans: Span[] = [];
  const pattern = /[^.!?。！？\n]*(?:[.!?。！？]+["'”’)\]]*|\n|$)\s*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) && match[0]) spans.push({ from: match.index, to: match.index + match[0].length });
  return spans;
}

/** The sentences of `text`, each without its surrounding whitespace. */
export function sentenceSpans(text: string): Span[] {
  const joined: Span[] = [];
  for (const segment of rawSegments(text)) {
    const last = joined.at(-1);
    if (last && ABBREVIATION.test(text.slice(last.from, last.to))) last.to = segment.to;
    else joined.push({ ...segment });
  }
  return joined.flatMap(({ from, to }) => {
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;
    return to > from ? [{ from, to }] : [];
  });
}

/** interior[p] is 1 where position p lies strictly inside a sentence, so a change cannot start or end there. */
export function sentenceInterior(text: string): Uint8Array {
  const interior = new Uint8Array(text.length + 1);
  for (const { from, to } of sentenceSpans(text)) interior.fill(1, from + 1, to);
  return interior;
}

/**
 * Grows changed regions to whole sentences in both texts. A region starts and
 * ends where neither text is inside a sentence; regions with no such place
 * between them become one ("A. B." → "A, and b." is one change of two
 * sentences). Regions `canJoin` refuses stay apart even inside a sentence.
 */
export function growToSentences(
  regions: readonly Region[],
  before: string,
  after: string,
  canJoin: (left: number, right: number) => boolean = () => true,
): SentenceRegion[] {
  const inBefore = sentenceInterior(before);
  const inAfter = sentenceInterior(after);
  const open = (o: number, n: number) => !inBefore[o] && !inAfter[n];
  const groups: SentenceRegion[] = [];
  let po = 0;
  let pn = 0;
  regions.forEach((region, index) => {
    // The unchanged stretch before this region: before[po, region.from) = after[pn, region.nf).
    const length = Math.min(region.from - po, region.nf - pn);
    let first = -1;
    let last = -1;
    for (let k = 0; k <= length; k++) {
      if (!open(po + k, pn + k)) continue;
      if (first < 0) first = k;
      last = k;
    }
    const current = groups.at(-1);
    if (current && first < 0 && canJoin(current.members.at(-1)!, index)) {
      current.to = region.to;
      current.ne = region.ne;
      current.members.push(index);
    } else {
      if (current) {
        const k = first < 0 ? 0 : first;
        current.to = po + k;
        current.ne = pn + k;
      }
      const k = last >= 0 ? last : current ? length : 0;
      groups.push({ from: po + k, nf: pn + k, to: region.to, ne: region.ne, members: [index] });
    }
    po = region.to;
    pn = region.ne;
  });
  const current = groups.at(-1);
  if (current) {
    const length = Math.min(before.length - po, after.length - pn);
    let k = 0;
    while (k < length && !open(po + k, pn + k)) k++;
    current.to = po + k;
    current.ne = pn + k;
  }
  return groups;
}
