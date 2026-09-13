import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";

export interface MarkdownFormula {
  formula: string;
  display: boolean;
  label: string;
}

export interface PreparedMarkdownMath {
  markdown: string;
  formulas: Map<string, MarkdownFormula>;
  pattern: RegExp;
}

const markdownParser = unified().use(remarkParse).use(remarkGfm);

function isEscaped(source: string, offset: number): boolean {
  let slashes = 0;
  while (offset > 0 && source[--offset] === "\\") slashes++;
  return slashes % 2 === 1;
}

/** Protect TeX before Markdown can interpret its backslashes and underscores.
 * Both import and preview use this scanner, including Pandoc's single-dollar
 * whitespace/currency rules. Markdown code, HTML, images and link destinations
 * are excluded using source positions, rather than regexes for code fences.
 */
export function protectedMarkdownRanges(source: string): Array<[number, number]> {
  const protectedRanges: Array<[number, number]> = [];
  function protect(node: Root | RootContent) {
    if (["code", "inlineCode", "html", "image", "imageReference", "definition"].includes(node.type)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) protectedRanges.push([start, end]);
      return;
    }
    if (node.type === "link" || node.type === "linkReference") {
      const start = node.children.at(-1)?.position?.end.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) protectedRanges.push([start, end]);
    }
    if ("children" in node) node.children.forEach(protect);
  }
  protect(markdownParser.parse(source));
  protectedRanges.sort((a, b) => a[0] - b[0]);
  return protectedRanges;
}

export function prepareMarkdownMath(source: string): PreparedMarkdownMath {
  const protectedRanges = protectedMarkdownRanges(source);

  let prefix = "SCHOLARPENMATHTOKEN";
  while (source.includes(prefix)) prefix += "Z";
  const formulas = new Map<string, MarkdownFormula>();
  const parts: string[] = [];
  let copiedUntil = 0;
  let rangeIndex = 0;

  for (let start = 0; start < source.length; start++) {
    while (protectedRanges[rangeIndex]?.[1] <= start) rangeIndex++;
    const range = protectedRanges[rangeIndex];
    if (range && start >= range[0]) { start = range[1] - 1; continue; }
    if (source[start] !== "$" || isEscaped(source, start)) continue;

    const display = source[start + 1] === "$";
    const width = display ? 2 : 1;
    const bodyStart = start + width;
    if (source[bodyStart] === "$" || (!display && /\s/.test(source[bodyStart] ?? " "))) {
      while (source[start + 1] === "$") start++;
      continue;
    }

    let close = bodyStart;
    for (; close < source.length; close++) {
      if (range && close >= range[0]) break;
      if (/^\r?\n[ \t]*\r?\n/.test(source.slice(close, close + 8))) break;
      if (source[close] !== "$" || isEscaped(source, close)) continue;
      if (display) {
        if (source[close + 1] === "$" && source[close + 2] !== "$") break;
      } else break;
    }
    if ((range && close >= range[0]) || source.slice(close, close + width) !== "$".repeat(width) ||
      (!display && (source[close + 1] === "$" || /\s/.test(source[close - 1]) || /\d/.test(source[close + 1] ?? "")))) {
      start += width - 1;
      continue;
    }
    const formula = source.slice(bodyStart, close).trim();
    if (!formula) { start = close + width - 1; continue; }
    let end = close + width;
    const labelMatch = display
      ? source.slice(end).match(/^[ \t]*(?:\r?\n[ \t]*)?\{#(eq-[\w:.-]+)\}/)
      : null;
    if (labelMatch) end += labelMatch[0].length;
    const token = `${prefix}${formulas.size}END`;
    formulas.set(token, { formula, display, label: labelMatch?.[1] ?? "" });
    parts.push(source.slice(copiedUntil, start), token);
    copiedUntil = end;
    start = end - 1;
  }
  parts.push(source.slice(copiedUntil));
  return { markdown: parts.join(""), formulas, pattern: new RegExp(`${prefix}\\d+END`, "g") };
}

export function splitMathPlaceholders(text: string, prepared: PreparedMarkdownMath): Array<string | MarkdownFormula> {
  const parts: Array<string | MarkdownFormula> = [];
  let offset = 0;
  for (const match of text.matchAll(new RegExp(prepared.pattern))) {
    if (match.index > offset) parts.push(text.slice(offset, match.index));
    parts.push(prepared.formulas.get(match[0]) ?? match[0]);
    offset = match.index + match[0].length;
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return parts;
}

/** Restore protected formulas as KaTeX-compatible nodes in the preview AST. */
export function remarkRestoreScholarMath(prepared: PreparedMarkdownMath) {
  return (tree: Root) => {
    function restore(node: Root | RootContent) {
      if (!("children" in node)) return;
      const children: RootContent[] = [];
      for (const child of node.children) {
        if (child.type === "text") {
          for (const part of splitMathPlaceholders(child.value, prepared)) {
            children.push(typeof part === "string" ? { type: "text", value: part } : {
              type: "inlineMath",
              value: part.formula,
              data: {
                hName: "code",
                hProperties: {
                  className: ["language-math", part.display ? "math-display" : "math-inline"],
                },
                hChildren: [{ type: "text", value: part.formula }],
              },
            });
          }
        } else {
          restore(child);
          children.push(child);
        }
      }
      node.children = children as typeof node.children;
    }
    restore(tree);
  };
}
