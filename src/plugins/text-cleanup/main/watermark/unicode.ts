import { STRIP_CODEPOINTS, SPACE_HOMOGLYPHS, PRESERVABLE_BIDI_CPS, ORTHOGRAPHIC_CF, MONGOLIAN_FVS, KHMER_VOWELS, HANGUL_FILLERS } from "./unicode-tables";

// TypeScript port of text_unicode.py's default clean_text/_decide policy.
// No NFKC, aggressive homoglyph conversion, strip-bidi, or strip-emoji-glue.
const between = (cp: number, from: number, to: number) => cp >= from && cp <= to;
const cjk = (cp: number) => between(cp, 0x3400, 0x4DBF) || between(cp, 0x4E00, 0x9FFF) || between(cp, 0xF900, 0xFAFF) || between(cp, 0x20000, 0x323AF);
const jamo = (cp: number) => between(cp, 0x1100, 0x11FF) || between(cp, 0xA960, 0xA97C) || between(cp, 0xD7B0, 0xD7C6) || between(cp, 0x3131, 0x318E) || between(cp, 0xFFA1, 0xFFDC);
const vsSupplement = (cp: number) => between(cp, 0xE0100, 0xE01EF);
const emoji = (cp: number) => between(cp, 0x1F000, 0x1FAFF) || between(cp, 0x2190, 0x25FF) || between(cp, 0x2600, 0x27BF) || between(cp, 0x2B00, 0x2BFF) ||
  [0x203C, 0x2049, 0x2139, 0x2934, 0x2935, 0xA9, 0xAE, 0x2122, 0x3030, 0x303D, 0x3297, 0x3299, 0x23, 0x2A].includes(cp) || between(cp, 0x30, 0x39);
const glue = (cp: number) => [0x200C, 0x200D].includes(cp) || between(cp, 0xFE00, 0xFE0F) || vsSupplement(cp) ||
  between(cp, 0xE0020, 0xE007F) || MONGOLIAN_FVS.has(cp) || KHMER_VOWELS.has(cp) || HANGUL_FILLERS.has(cp);
const joiningRanges = [[0x600, 0x8FF], [0x900, 0xDFF], [0xF00, 0x109F], [0x1780, 0x17FF], [0x1800, 0x18AF]];
function joiningScript(ch: string | undefined) {
  if (!ch || !/[\p{L}\p{M}]/u.test(ch)) return -1;
  return joiningRanges.findIndex(([from, to]) => between(ch.codePointAt(0)!, from, to));
}
const layout = [[0x13430, 0x1343F, 0x13000, 0x143FF], [0x1BCA0, 0x1BCA3, 0x1BC00, 0x1BCA3], [0x1D173, 0x1D17A, 0x1D100, 0x1D1FF]];
function strip(cp: number, ch: string) {
  return STRIP_CODEPOINTS.has(cp) || vsSupplement(cp) || between(cp, 0xE0001, 0xE007F) ||
    between(cp, 0xFDD0, 0xFDEF) || (cp & 0xFFFE) === 0xFFFE || cp === 0x2065 || cp === 0xE0000 ||
    between(cp, 0xFFF0, 0xFFF8) || between(cp, 0xE0080, 0xE00FF) || between(cp, 0xE01F0, 0xE0FFF) ||
    between(cp, 0xE000, 0xF8FF) || between(cp, 0xF0000, 0xFFFFD) || between(cp, 0x100000, 0x10FFFD) || /\p{Cf}/u.test(ch);
}

export interface UnicodeEdit { from: number; to: number; insert: string }

/** UTF-16 offsets match ProseMirror; decisions iterate full Unicode code points. */
export function cleanUnicode(text: string) {
  const chars = [...text], cps = chars.map(ch => ch.codePointAt(0)!);
  const preserved = new Set<number>();
  const bidi: Array<[number, number]> = [];
  for (let i = 0; i < cps.length; i++) {
    if ([0x202A, 0x202B, 0x202D, 0x202E].includes(cps[i])) bidi.push([cps[i], i]);
    else if (cps[i] === 0x202C) {
      const opener = bidi.pop();
      if (opener && [0x202A, 0x202B].includes(opener[0])) { preserved.add(opener[1]); preserved.add(i); }
    }
    if (cps[i] === 0x1F3F4) {
      let end = i + 1;
      while (end < cps.length && between(cps[end], 0xE0020, 0xE007E)) end++;
      if (end > i + 1 && cps[end] === 0xE007F) for (let at = i + 1; at <= end; at++) preserved.add(at);
    }
  }
  const edits: UnicodeEdit[] = [];
  let previousKept = "", offset = 0, removed = 0, replaced = 0, cleaned = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i], cp = cps[i], previous = cps[i - 1], next = cps[i + 1], kept = previousKept.codePointAt(0) ?? -1;
    const script = joiningScript(chars[i - 1]);
    const keep = preserved.has(i) || PRESERVABLE_BIDI_CPS.has(cp) || ORTHOGRAPHIC_CF.has(cp) ||
      ((vsSupplement(cp) || between(cp, 0xFE00, 0xFE0D)) && cjk(previous)) ||
      (MONGOLIAN_FVS.has(cp) && between(previous, 0x1800, 0x18AF)) ||
      ([0xFE0E, 0xFE0F].includes(cp) && emoji(previous)) ||
      (cp === 0x200D && emoji(kept) && emoji(next)) ||
      ([0x200C, 0x200D].includes(cp) && script >= 0 && script === joiningScript(chars[i + 1])) ||
      (MONGOLIAN_FVS.has(cp) && between(kept, 0x1800, 0x18AF) && /\p{L}/u.test(previousKept)) ||
      (KHMER_VOWELS.has(cp) && between(kept, 0x1780, 0x17FF) && /\p{L}/u.test(previousKept)) ||
      (HANGUL_FILLERS.has(cp) && jamo(kept)) ||
      layout.some(([from, to, scriptFrom, scriptTo]) => between(cp, from, to) && (between(previous, scriptFrom, scriptTo) || between(next, scriptFrom, scriptTo)));
    const output = keep ? ch : strip(cp, ch) ? "" : SPACE_HOMOGLYPHS.has(cp) ? " " : ch;
    if (output !== ch) {
      edits.push({ from: offset, to: offset + ch.length, insert: output });
      if (output) replaced++; else removed++;
    }
    if (output && (output !== ch || !glue(cp))) previousKept = output;
    cleaned += output;
    offset += ch.length;
  }
  return { text: cleaned, edits, removed, replaced };
}
