// ── ScholarPen Markdown / Quarto Export Serializer ────────────────
// Converts BlockNote document blocks to Markdown or Quarto (.qmd) format.
// Custom blocks (math, figure, abstract) use format-specific representations.

import type { BlockNoteEditor } from "@blocknote/core";
import { figureExportUrl } from "../../shared/figure-files";
import { NOTE_MARKER } from "./markdown-notes";
import { isEscaped } from "./markdown-math";
import { normalizeFigureCaption } from "./caption-markdown";
import { blockLabel, collectReferenceTargets, duplicateReferenceLabels, normalizeQuartoBlocks,
  validFigureDimension, validQuartoLabel } from "../../shared/quarto-references";
import { withoutAIPlaceholders } from "../../shared/collab/ai-placeholder";

export type ExportFormat = "md" | "qmd";

const SCHOLARPEN_DOCUMENT_EXTENSION = /\.scholarpen\.json$/i;
const LEADING_DOCUMENT_NUMBER = /^\s*\d+\s*(?:[.)_:-]\s*)?/;

interface Block {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content: unknown;
  children: Block[];
}

export function documentTitleFromFilename(filename: string): string {
  const basename = filename.replace(SCHOLARPEN_DOCUMENT_EXTENSION, "").trim();
  const title = basename.replace(LEADING_DOCUMENT_NUMBER, "").trim();
  return title || basename || "Document";
}

export function buildQuartoFrontmatter(
  date = new Date(),
): string {
  return [
    "---",
    `date: "${date.toISOString().split("T")[0]}"`,
    "bibliography: references.bib",
    "---",
  ].join("\n");
}

/**
 * Extract plain text from BlockNote inline content.
 */
function extractInlineText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractInlineText).join("");
  if (typeof content === "object" && content !== null) {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (Array.isArray(obj.content)) return extractInlineText(obj.content);
  }
  return "";
}

function isBlankParagraph(block: Block): boolean {
  return block.type === "paragraph" && !extractInlineText(block.content).trim() && !block.children?.length;
}

function inlineProp(obj: Record<string, unknown>, key: string): unknown {
  const props = obj.props as Record<string, unknown> | undefined;
  return props?.[key] ?? obj[key];
}

/** BlockNote's own Markdown converter drops ScholarPen's inline content and
 * underline, so blocks holding either are written by `InlineMarkdownWriter`. */
function needsScholarInline(content: unknown): boolean {
  if (!content) return false;
  if (Array.isArray(content)) return content.some(needsScholarInline);
  if (typeof content === "object" && content !== null) {
    const obj = content as Record<string, unknown>;
    if (["citation", "crossReference", "quartoLiteral", "footnote", "inlineMath"].includes(String(obj.type))) return true;
    if ((obj.styles as Record<string, unknown> | undefined)?.underline) return true;
    if (obj.type === "tableContent") return needsScholarInline(obj.rows);
    if (Array.isArray(obj.cells)) return needsScholarInline(obj.cells);
    return needsScholarInline(obj.content);
  }
  return false;
}

function citationToMarkdown(content: unknown): string | null {
  if (typeof content !== "object" || content === null) return null;

  const obj = content as Record<string, unknown>;
  if (obj.type !== "citation" && !(obj.type === "crossReference" && inlineProp(obj, "bracketed"))) return null;

  const citekey = inlineProp(obj, obj.type === "crossReference" ? "label" : "citekey");
  if (typeof citekey !== "string" || !citekey.trim()) return null;
  if (obj.type === "crossReference" && !validQuartoLabel(citekey)) throw new Error(`Invalid cross-reference: @${citekey}`);

  const locator = inlineProp(obj, "locator");
  const locatorSuffix = typeof locator === "string" && locator.trim()
    ? `, ${locator}`
    : "";
  return `@${citekey}${locatorSuffix}`;
}

/**
 * Inline TeX for Pandoc's `tex_math_dollars`: no whitespace may follow the opening
 * `$` or precede the closing one, or Pandoc reads the dollars
 * (and drops commands such as `\times` as raw TeX) instead of math. A formula with
 * nothing but whitespace is no formula.
 */
export function inlineMathToMarkdown(formula: string): string {
  const tex = formula.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return tex ? `$${tex}$` : "";
}

/** Display math may not contain a blank line between its `$$` delimiters. */
function displayMathBody(formula: string): string {
  return formula.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim()).join("\n");
}

type DelimitedStyle = "bold" | "italic" | "strike" | "underline";
/** Outermost first, for styles that start on the same character. */
const DELIMITED_STYLES: readonly DelimitedStyle[] = ["bold", "italic", "strike", "underline"];
const STYLE_DELIMITERS: Record<DelimitedStyle, readonly [string, string]> = {
  bold: ["**", "**"], italic: ["*", "*"], strike: ["~~", "~~"], underline: ["<u>", "</u>"],
};
/** Pandoc leaves raw `<u>` out of Word and PDF output; its own underline is a
 * bracketed span (read back by `pandocUnderlineToHtml` on import). */
const PANDOC_UNDERLINE = ["[", "]{.underline}"] as const;
const ATOM_TYPES = new Set(["citation", "crossReference", "quartoLiteral", "footnote", "inlineMath", "link"]);

interface TextRun { type?: string; text: string; styles?: Record<string, unknown> }

function isTextRun(item: unknown): item is TextRun {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as Record<string, unknown>;
  return typeof obj.text === "string" && !ATOM_TYPES.has(String(obj.type));
}

function runStyleKey(run: TextRun): string {
  const styles = run.styles ?? {};
  return [...DELIMITED_STYLES, "code"].filter((style) => styles[style]).join(" ");
}

/** Runs that only differ in styles Markdown cannot show (colour, AI authorship)
 * are one run: `*a**b*` is not emphasis, and two code spans in a row merge. */
function mergeTextRuns(items: unknown[]): unknown[] {
  const merged: unknown[] = [];
  for (const item of items) {
    const previous = merged.at(-1);
    if (isTextRun(item) && isTextRun(previous) && runStyleKey(item) === runStyleKey(previous)) {
      merged[merged.length - 1] = { ...previous, text: previous.text + item.text };
    } else merged.push(item);
  }
  return merged;
}

function codeSpan(code: string): string {
  const fence = "`".repeat(Math.max(0, ...Array.from(code.matchAll(/`+/g), (match) => match[0].length)) + 1);
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${fence}${pad}${code}${pad}${fence}`;
}

/** Pandoc reads text glued to a bare `@label` as part of the key or not as a
 * citation at all; brackets keep it a reference. */
const BARE_REFERENCE_UNSAFE_BEFORE = /[\p{L}\p{N}_@.*]$/u;
const BARE_REFERENCE_UNSAFE_AFTER = /^(?:[\p{L}\p{N}_@[]|[:.#$%&\-+?<>~/][\p{L}\p{N}_])/u;

/**
 * Writes inline content as Pandoc Markdown. Styles open and close only where
 * they change between runs, whitespace at a style boundary goes outside the
 * delimiters (Pandoc does not read `* for each*` as emphasis), and a run with
 * no visible text never gets delimiters.
 */
class InlineMarkdownWriter {
  private out = "";
  private open: DelimitedStyle[] = [];
  /** Whitespace not yet written, held until we know which delimiters go before it. */
  private space = "";

  constructor(private readonly format: ExportFormat, private readonly tableCell: boolean) {}

  write(content: unknown[]): string {
    const items = mergeTextRuns(content);
    for (let index = 0; index < items.length;) {
      const item = items[index];
      const citation = this.format === "qmd" ? citationToMarkdown(item) : null;
      if (citation) {
        const citations = [citation];
        for (index += 1; index < items.length; index += 1) {
          const next = citationToMarkdown(items[index]);
          if (!next) break;
          citations.push(next);
        }
        this.atom(`[${citations.join("; ")}]`);
        continue;
      }
      if (isTextRun(item)) this.text(item);
      else if (typeof item === "object" && item !== null) this.inline(item as Record<string, unknown>, items[index + 1]);
      index += 1;
    }
    this.closeTo(0);
    this.flushSpace();
    return this.out;
  }

  private text(run: TextRun) {
    const styles = run.styles ?? {};
    let keep = 0;
    while (keep < this.open.length && styles[this.open[keep]]) keep += 1;
    this.closeTo(keep);
    const core = run.text.trim();
    if (!core) {
      this.space += run.text;
      return;
    }
    this.space += run.text.slice(0, run.text.length - run.text.trimStart().length);
    this.flushSpace();
    for (const style of DELIMITED_STYLES) {
      if (!styles[style] || this.open.includes(style)) continue;
      const opener = this.delimiters(style)[0];
      if (opener.startsWith("[")) this.escapeImageBang();
      this.out += opener;
      this.open.push(style);
    }
    let markdown = styles.code ? codeSpan(core) : core;
    if (!styles.code && this.tableCell) markdown = markdown.replace(/\|/g, "\\|");
    // Text brackets would end or unbalance a Pandoc underline span.
    if (!styles.code && this.format === "qmd" && this.open.includes("underline")) {
      markdown = markdown.replace(/[[\]]/g, "\\$&");
    }
    this.out += markdown;
    this.space = run.text.slice(run.text.trimEnd().length);
  }

  private delimiters(style: DelimitedStyle): readonly [string, string] {
    return style === "underline" && this.format === "qmd" ? PANDOC_UNDERLINE : STYLE_DELIMITERS[style];
  }

  /** A `!` right before `[` turns a span, link, citation or footnote into an attempted image. */
  private escapeImageBang() {
    if (this.out.endsWith("!") && !isEscaped(this.out, this.out.length - 1)) this.out = `${this.out.slice(0, -1)}\\!`;
  }

  private inline(obj: Record<string, unknown>, next: unknown) {
    switch (obj.type) {
      case "citation": {
        const citation = citationToMarkdown(obj);
        if (citation) this.atom(`[${citation}]`);
        return;
      }
      case "crossReference": {
        const label = String(inlineProp(obj, "label") ?? "");
        if (!validQuartoLabel(label)) throw new Error(`Invalid cross-reference: @${label}`);
        const locator = String(inlineProp(obj, "locator") ?? "");
        const reference = `@${label}${locator ? `, ${locator}` : ""}`;
        if (inlineProp(obj, "bracketed")) return this.atom(`[${reference}]`);
        this.closeTo(0);
        this.flushSpace();
        const after = next === undefined ? "" : new InlineMarkdownWriter(this.format, this.tableCell).write([next]);
        if (BARE_REFERENCE_UNSAFE_BEFORE.test(this.out) || BARE_REFERENCE_UNSAFE_AFTER.test(after)) {
          this.escapeImageBang();
          this.out += `[${reference}]`;
        } else this.out += reference;
        return;
      }
      case "quartoLiteral":
        return this.atom(String(inlineProp(obj, "source") ?? ""));
      case "footnote": {
        const index = inlineProp(obj, "index") ?? inlineProp(obj, "number");
        if (typeof index === "number" || typeof index === "string") this.atom(`[^${index}]`);
        return;
      }
      case "inlineMath": {
        const formula = inlineProp(obj, "formula");
        if (typeof formula === "string") this.atom(inlineMathToMarkdown(formula));
        return;
      }
      case "link":
        if (typeof obj.href !== "string") return;
        return this.atom(`[${inlineContentToMarkdown(obj.content, this.format, this.tableCell)}](${obj.href})`);
    }
  }

  /** Math, citations and other unstyled inline content end every open style. */
  private atom(markdown: string) {
    if (!markdown) return;
    this.closeTo(0);
    this.flushSpace();
    if (markdown.startsWith("[")) this.escapeImageBang();
    this.out += markdown;
  }

  private closeTo(depth: number) {
    while (this.open.length > depth) this.out += this.delimiters(this.open.pop()!)[1];
  }

  private flushSpace() {
    this.out += this.space;
    this.space = "";
  }
}

/**
 * Convert inline content to Markdown with styling preserved.
 */
export function inlineContentToMarkdown(content: unknown, format: ExportFormat, tableCell = false): string {
  if (!content) return "";
  if (typeof content === "string") return tableCell ? content.replace(/\|/g, "\\|") : content;
  return new InlineMarkdownWriter(format, tableCell).write(Array.isArray(content) ? content : [content]);
}

/**
 * Serialize BlockNote document to Markdown or Quarto format.
 *
 * Standard blocks are delegated to BlockNote's built-in `blocksToMarkdownLossy`.
 * Custom blocks are serialized with format-specific rules.
 */
export async function blocksToScholarMarkdown(
  editor: BlockNoteEditor<any, any, any>,
  blocks: Block[],
  format: ExportFormat = "md",
  title = "Document",
  options: { filename?: string } = {},
): Promise<string> {
  const lines: string[] = [];
  // AI drafting placeholders are plans, not text.
  blocks = withoutAIPlaceholders(normalizeQuartoBlocks(blocks));
  if (format === "qmd") {
    // Quarto counts YAML title and a body H1 as separate book headings.
    // Keep the existing H1 (including its identifier) as the sole title.
    let chapter = blocks.find((block) => block.type === "heading" && (block.props.level ?? 1) === 1);
    const isIndex = /(?:^|[/\\])index\.(?:qmd|scholarpen\.json)$/i.test(options.filename ?? "");
    // A document that opens with a top-level heading already names its chapter:
    // make that heading the H1 instead of adding the filename above it as a second title.
    const opening = chapter ? undefined : blocks.find((block) => !isBlankParagraph(block));
    const headingLevel = (block: Block) => Number(block.props.level ?? 1);
    const topLevel = Math.min(...blocks.filter((block) => block.type === "heading").map(headingLevel));
    if (opening?.type === "heading" && headingLevel(opening) === topLevel) {
      opening.props.level = 1;
      chapter = opening;
    }
    if (!chapter) {
      chapter = { id: "", type: "heading", props: { level: 1 },
        content: [{ type: "text", text: title, styles: {} }], children: [] };
      blocks.unshift(chapter);
    }
    if (isIndex) {
      const classes = new Set(String(chapter.props.quartoClasses ?? "").split(/\s+/).filter(Boolean));
      classes.add("unnumbered");
      chapter.props.quartoClasses = [...classes].join(" ");
    }
  }
  const duplicates = duplicateReferenceLabels(blocks);
  if (format === "qmd" && duplicates.length) {
    throw new Error(`Duplicate Quarto identifiers: ${duplicates.join(", ")}. Give each target a unique identifier in Quarto properties.`);
  }
  if (format === "qmd") for (const target of collectReferenceTargets(blocks)) {
    if (!validQuartoLabel(target.label, target.type)) throw new Error(`Invalid ${target.type} identifier: ${target.label}`);
  }

  // Quarto: add YAML frontmatter
  if (format === "qmd") {
    // Numbering is a book-wide _quarto.yml choice; a chapter's own value would override it.
    lines.push(buildQuartoFrontmatter());
  }

  for (const block of blocks) {
    const md = await blockToMarkdown(editor, block, format, 0);
    lines.push(md);
  }

  return lines.join("\n\n");
}

async function blockToMarkdown(
  editor: BlockNoteEditor<any, any, any>,
  block: Block,
  format: ExportFormat,
  depth: number
): Promise<string> {
  const indent = depth > 0 ? "  ".repeat(depth) : "";

  switch (block.type) {
    case "note": {
      const title = String(block.props.title ?? "읽는 법").replace(/[\r\n]+/g, " ") || "읽는 법";
      const body = [inlineContentToMarkdown(block.content, format)];
      for (const child of block.children ?? []) body.push(await blockToMarkdown(editor, child, format, 0));
      const text = body.filter(Boolean).join("\n\n");
      if (format === "qmd") {
        const longestFence = Math.max(2, ...Array.from(text.matchAll(/^(:{3,})/gm), (match) => match[1].length));
        const fence = ":".repeat(longestFence + 1);
        return `${fence} {.callout-note title="${title.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" appearance="simple" icon="false"}\n${text}\n${fence}`;
      }
      const escapedTitle = title.replace(/[\\*]/g, "\\$&");
      return `${NOTE_MARKER}\n> **${escapedTitle}**\n>\n${text.split("\n").map((line) => `> ${line}`).join("\n")}`;
    }
    case "math":
      return mathBlockToMarkdown(block, format);

    case "figure":
      return figureBlockToMarkdown(block, format);

    case "abstract":
      return abstractBlockToMarkdown(block, format);

    default:
      if (block.type === "heading" || block.type === "table" || needsScholarInline(block.content)) {
        const custom = standardBlockToMarkdown(block, depth, format);
        if (block.children && block.children.length > 0) {
          const childLines: string[] = [];
          for (const child of block.children) {
            const childMd = await blockToMarkdown(editor, child, format, depth + 1);
            childLines.push(childMd);
          }
          return custom + "\n" + childLines.join("\n");
        }
        return custom;
      }

      // Standard blocks: delegate to BlockNote's built-in converter
      try {
        const md = await editor.blocksToMarkdownLossy([{ ...block, children: [] } as any]);
        // Remove trailing newlines that blocksToMarkdownLossy may add
        const trimmed = md.trimEnd();

        // Handle nested children
        if (block.children && block.children.length > 0) {
          const childLines: string[] = [];
          for (const child of block.children) {
            const childMd = await blockToMarkdown(editor, child, format, depth + 1);
            childLines.push(childMd);
          }
          return trimmed + "\n" + childLines.join("\n");
        }

        return indent + trimmed;
      } catch {
        // Fallback: extract text content
        const text = extractInlineText(block.content);
        return indent + text;
      }
  }
}

function standardBlockToMarkdown(
  block: Block,
  depth: number,
  format: ExportFormat,
): string {
  const indent = depth > 0 ? "  ".repeat(depth) : "";
  const text = inlineContentToMarkdown(block.content, format);

  switch (block.type) {
    case "table": {
      const table = block.content as { columnWidths?: (number | undefined)[]; headerRows?: number; rows: { cells: any[] }[] };
      if (format === "qmd" && ((table.headerRows ?? 1) > 1 || table.rows.some((row) => row.cells.some((cell) =>
        (cell.props?.colspan ?? 1) > 1 || (cell.props?.rowspan ?? 1) > 1)))) {
        throw new Error("Quarto pipe tables cannot preserve merged cells or multiple header rows. Split merged cells and use one header row before exporting.");
      }
      const alignment = table.rows[0]?.cells.map((cell) => cell.props?.textAlignment ?? "left") ?? [];
      // Pandoc splits pipe-table cells around math and code spans, so only plain
      // text escapes `|`: `$\|x\|$` would turn |x| into ‖x‖.
      const rows = table.rows.map((row) => `${indent}| ${row.cells.map((cell) => {
        const content = Array.isArray(cell) ? cell : (cell as { content: unknown }).content;
        return inlineContentToMarkdown(content, format, true).replace(/\n/g, "<br>");
      }).join(" | ")} |`);
      if (rows.length) rows.splice(1, 0, `${indent}| ${alignment.map((align) => align === "right" ? "---:" : align === "center" ? ":---:" : ":---").join(" | ")} |`);
      if (format === "qmd") {
        const attrs: string[] = [];
        const label = blockLabel(block);
        if (label) attrs.push(`#${label}`);
        const widths = table.columnWidths;
        if (widths?.some((width) => typeof width === "number" && width > 0)) {
          const numeric = alignment.map((_, index) => Number(widths[index]) > 0 ? Number(widths[index]) : 150);
          const sum = numeric.reduce((a, b) => a + b, 0);
          attrs.push(`tbl-colwidths="[${numeric.map((width) => Math.round(width / sum * 10000) / 100).join(",")}]"`);
        }
        const caption = String(block.props.caption ?? "");
        if (caption || attrs.length) rows.push("", `${indent}: ${caption}${attrs.length ? ` {${attrs.join(" ")}}` : ""}`.trimEnd());
      }
      return rows.join("\n");
    }
    case "heading": {
      const level = typeof block.props.level === "number" ? block.props.level : 1;
      const label = format === "qmd" ? blockLabel(block) : "";
      const classes = format === "qmd" ? String(block.props.quartoClasses ?? "").split(/\s+/)
        .filter((name) => /^[A-Za-z][\w-]*$/.test(name)).map((name) => `.${name}`) : [];
      const attrs = [...(label ? [`#${label}`] : []), ...classes];
      return `${indent}${"#".repeat(Math.max(1, Math.min(level, 6)))} ${text}${attrs.length ? ` {${attrs.join(" ")}}` : ""}`;
    }
    case "bulletListItem":
      return `${indent}- ${text}`;
    case "numberedListItem":
      return `${indent}1. ${text}`;
    case "checkListItem": {
      const checked = block.props.checked === true ? "x" : " ";
      return `${indent}- [${checked}] ${text}`;
    }
    case "quote":
      return text
        .split("\n")
        .map((line) => `${indent}> ${line}`)
        .join("\n");
    case "codeBlock":
    case "code": {
      const language = typeof block.props.language === "string" ? block.props.language : "";
      return `${indent}\`\`\`${language}\n${text}\n${indent}\`\`\``;
    }
    default:
      return `${indent}${text}`;
  }
}

function mathBlockToMarkdown(block: Block, format: ExportFormat): string {
  const formula = displayMathBody(typeof block.props.formula === "string" ? block.props.formula : "");
  if (!formula) return "";
  const label = format === "qmd" && typeof block.props.label === "string" && /^eq-[\w:.-]+$/.test(block.props.label)
    ? ` {#${block.props.label}}` : "";
  return `$$\n${formula}\n$$${label}`;
}

function figureBlockToMarkdown(block: Block, format: ExportFormat): string {
  const url = block.props.sourcePath ? figureExportUrl(String(block.props.sourcePath)) : (block.props.url as string) || "";
  const caption = normalizeFigureCaption((block.props.caption as string) || "");
  const altText = (block.props.altText as string) || caption || "figure";

  if (format === "qmd") {
    const attrs: string[] = [];
    const label = blockLabel(block);
    if (label) attrs.push(`#${label}`);
    for (const dimension of ["width", "height"] as const) {
      const value = String(block.props[dimension] ?? "");
      if (!validFigureDimension(value)) throw new Error(`Invalid figure ${dimension}: ${value}`);
      if (value) attrs.push(`${dimension}="${value}"`);
    }
    const align = block.props.alignment;
    if (["left", "center", "right"].includes(String(align))) attrs.push(`fig-align="${align}"`);
    if (block.props.altText) attrs.push(`fig-alt="${String(block.props.altText).replace(/"/g, "&quot;")}"`);
    // Caption and accessibility text have different meanings in Pandoc.
    return `![${caption || (label ? "Figure" : "")}](<${url.replace(/>/g, "%3E")}>)${attrs.length ? `{${attrs.join(" ")}}` : ""}`;
  }

  return `![${caption || altText}](${url})`;
}

function abstractBlockToMarkdown(block: Block, format: ExportFormat): string {
  const text = inlineContentToMarkdown(block.content, format);

  if (format === "qmd") {
    // Quarto fenced div
    return `::: abstract\n${text}\n:::`;
  }

  // Standard Markdown: blockquote with bold header
  const quoted = text
    .split("\n")
    .map((line: string) => `> ${line}`)
    .join("\n");
  return `> **Abstract**\n>\n${quoted}`;
}
