import { protectedMarkdownRanges } from "./markdown-math";
import { isQuartoReference } from "../../shared/quarto-references";

export interface ImportedCitation { citekey: string; locator: string; bare?: boolean; literal?: string }

/** Preserve citekeys before Markdown interprets underscores or brackets. */
export function prepareMarkdownCitations(source: string) {
  const protectedRanges = protectedMarkdownRanges(source);
  let prefix = "SCHOLARPENCITATIONTOKEN";
  while (source.includes(prefix)) prefix += "Z";
  const citations = new Map<string, ImportedCitation[]>();
  const markdown = source.replace(/\\\[@[^\]\n]+\]|\\@[A-Za-z][\w:.-]*|\[@[^\]\n]+\]|(?<![\w@\\])@[A-Za-z][\w:.-]*/g, (match, offset: number) => {
    if (protectedRanges.some(([start, end]) => offset >= start && offset < end)) return match;
    const precedingSlashes = source.slice(0, offset).match(/\\+$/)?.[0].length ?? 0;
    if (precedingSlashes % 2) return match;
    // A Markdown link label is not a Pandoc citation.
    if (/^[([]/.test(source.slice(offset + match.length))) return match;
    const entries: ImportedCitation[] = [];
    let trailing = "";
    if (match.startsWith("\\")) {
      entries.push({ citekey: "", locator: "", literal: match });
    } else if (match.startsWith("@")) {
      const key = match.slice(1).replace(/[.:]+$/, "");
      if (!isQuartoReference(key)) return match;
      trailing = match.slice(1 + key.length);
      entries.push({ citekey: key, locator: "", bare: true });
    } else {
      for (const item of match.slice(1, -1).split(";")) {
        const parsed = item.trim().match(/^@([^\s,;\[\]@]+)(?:\s*,\s*(.+))?$/);
        if (!parsed) return match;
        entries.push({ citekey: parsed[1], locator: parsed[2] ?? "" });
      }
    }
    const token = `${prefix}${citations.size}END`;
    citations.set(token, entries);
    return token + trailing;
  });
  return { markdown, citations, pattern: new RegExp(`(${prefix}\\d+END)`, "g") };
}

export type PreparedMarkdownCitations = ReturnType<typeof prepareMarkdownCitations>;
