export interface TextStatistics { words: number; graphemes: number; nonWhitespace: number; paragraphs: number; eojeol: number }
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });
/** Segmentation is independent from the history checkpoint's legacy word-count contract. */
export function countText(text: string): TextStatistics {
  const chars = [...graphemes.segment(text)];
  return {
    words: [...words.segment(text)].filter(s => s.isWordLike).length,
    graphemes: chars.length,
    nonWhitespace: chars.filter(s => /\S/u.test(s.segment)).length,
    paragraphs: text.split(/\n+/u).filter(line => line.trim()).length,
    eojeol: text.trim() ? text.trim().split(/\s+/u).length : 0,
  };
}
