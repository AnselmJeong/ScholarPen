import { isEscaped, protectedMarkdownRanges } from "./markdown-math";

const PANDOC_UNDERLINE_END = /\]\{\.(?:underline|ul)\}/g;

/**
 * Pandoc (and the `.qmd` export) writes underline as a bracketed span,
 * `[text]{.underline}` or `[text]{.ul}`; BlockNote's Markdown parser reads `<u>`.
 * Code, raw HTML and link destinations are left alone, as is a span after an
 * unescaped `!`, which Pandoc does not read as one either.
 */
export function pandocUnderlineToHtml(source: string): string {
  const protectedRanges = protectedMarkdownRanges(source);
  const isProtected = (offset: number) => protectedRanges.some(([start, end]) => offset >= start && offset < end);
  const edits: { start: number; end: number; text: string }[] = [];
  for (const match of source.matchAll(PANDOC_UNDERLINE_END)) {
    const close = match.index;
    if (isEscaped(source, close) || isProtected(close)) continue;
    let depth = 0;
    let open = -1;
    for (let offset = close - 1; offset >= 0; offset -= 1) {
      const char = source[offset];
      if (char === "\n" && /\n[ \t]*$/.test(source.slice(0, offset))) break; // a span stays in its paragraph
      if ((char !== "[" && char !== "]") || isEscaped(source, offset) || isProtected(offset)) continue;
      if (char === "]") depth += 1;
      else if (depth) depth -= 1;
      else {
        open = offset;
        break;
      }
    }
    if (open < 0 || (source[open - 1] === "!" && !isEscaped(source, open - 1))) continue;
    edits.push({ start: open, end: open + 1, text: "<u>" }, { start: close, end: close + match[0].length, text: "</u>" });
  }
  let markdown = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) markdown = markdown.slice(0, edit.start) + edit.text + markdown.slice(edit.end);
  return markdown;
}
