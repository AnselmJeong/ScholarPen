import { readableHunks } from "../../../shared/collab/suggested-edits";
import type { Hunk } from "./text-diff";

/** One cited work inside a Pandoc citation group such as `[@a, p. 3; @b]`. */
export interface CitationItem { key: string; locator: string }
/** A complete `[@…]` group in edited prose. */
export interface CitationSpan { from: number; to: number; items: CitationItem[] }

const GROUP = /\[(@[^\]\n]*)\]/g;
const ITEM = /^\s*@([^\s,;\]]+)(?:\s*,\s*([^;]*?))?\s*$/;
/** Placeholder for a work that is not yet in references.bib, e.g. `[@doi:10.1000/xyz]`. */
export const DOI_KEY = /^doi:(10\.\d{4,9}\/\S+)$/i;

/** Every well-formed `[@key]` group in a piece of prose. Malformed brackets are left as text. */
export function findCitations(text: string): CitationSpan[] {
  const spans: CitationSpan[] = [];
  for (const match of text.matchAll(GROUP)) {
    const items: CitationItem[] = [];
    for (const part of match[1].split(";")) {
      const parsed = part.match(ITEM);
      if (!parsed) { items.length = 0; break; }
      items.push({ key: parsed[1], locator: parsed[2]?.trim() ?? "" });
    }
    if (items.length) spans.push({ from: match.index!, to: match.index! + match[0].length, items });
  }
  return spans;
}

function formatGroup(items: CitationItem[]) {
  return `[${items.map(item => `@${item.key}${item.locator ? `, ${item.locator}` : ""}`).join("; ")}]`;
}

/**
 * Rewrites the citation keys in a passage: `map` returns the new key, or null
 * to drop the item. A group that loses every item is removed with the space
 * before it, so "claim [@x]." becomes "claim.".
 */
export function rewriteCitations(text: string, map: (key: string) => string | null) {
  let output = "";
  let cursor = 0;
  for (const span of findCitations(text)) {
    const items = span.items.flatMap(item => {
      const key = map(item.key);
      return key ? [{ ...item, key }] : [];
    });
    let start = span.from;
    if (!items.length) while (start > cursor && /[ \t]/.test(text[start - 1])) start--;
    output += text.slice(cursor, start) + (items.length ? formatGroup(items) : "");
    cursor = span.to;
  }
  return output + text.slice(cursor);
}

type Located = Hunk & { nf: number; ne: number };

/**
 * Readable hunks whose inserted text always contains whole citation groups,
 * so each group can be turned into citation nodes. Only groups whose keys are
 * all known are returned; the rest stay plain text.
 */
export function citationHunks(original: string, revised: string, known: (key: string) => boolean) {
  const spans = findCitations(revised).filter(span => span.items.every(item => known(item.key)));
  let delta = 0;
  let hunks: Located[] = readableHunks(original, revised).map(hunk => {
    const nf = hunk.from + delta;
    delta += hunk.insert.length - (hunk.to - hunk.from);
    return { ...hunk, nf, ne: nf + hunk.insert.length };
  });
  for (const span of spans) {
    const touching = hunks.filter(hunk => hunk.nf < span.to && (hunk.ne > span.from || (hunk.nf === hunk.ne && hunk.nf > span.from)));
    if (!touching.length) continue; // Already in the original text; never re-created.
    if (touching.length === 1 && touching[0].nf <= span.from && touching[0].ne >= span.to) continue;
    const first = touching[0], last = touching[touching.length - 1];
    const nf = Math.min(span.from, first.nf), ne = Math.max(span.to, last.ne);
    // Outside hunks the texts are identical, so offsets move one for one.
    let merged: Located = { from: first.from - (first.nf - nf), to: last.to + (ne - last.ne), insert: revised.slice(nf, ne), nf, ne };
    // Keep unchanged text around the group out of the hunk, so the suggestion stays minimal.
    let head = 0, tail = 0;
    while (merged.nf + head < span.from && merged.from + head < merged.to && original[merged.from + head] === revised[merged.nf + head]) head++;
    while (merged.ne - tail > span.to && merged.to - tail > merged.from + head && original[merged.to - tail - 1] === revised[merged.ne - tail - 1]) tail++;
    merged = { from: merged.from + head, to: merged.to - tail, insert: revised.slice(merged.nf + head, merged.ne - tail), nf: merged.nf + head, ne: merged.ne - tail };
    // Any other hunk inside [nf, ne) would overlap the group and so be touching it.
    hunks = [...hunks.filter(hunk => !touching.includes(hunk)), merged].sort((a, b) => a.nf - b.nf);
  }
  return hunks.map(hunk => ({
    from: hunk.from, to: hunk.to, insert: hunk.insert,
    citations: spans.filter(span => span.from >= hunk.nf && span.to <= hunk.ne)
      .map(span => ({ ...span, from: span.from - hunk.nf, to: span.to - hunk.nf })),
  }));
}
