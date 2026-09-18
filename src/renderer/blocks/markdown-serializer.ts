// ── ScholarPen Markdown / Quarto Export Serializer ────────────────
// Converts BlockNote document blocks to Markdown or Quarto (.qmd) format.
// Custom blocks (math, figure, abstract) use format-specific representations.

import type { BlockNoteEditor } from "@blocknote/core";
import { figureExportUrl } from "../../shared/figure-files";
import { blockLabel, collectReferenceTargets, duplicateReferenceLabels, normalizeQuartoBlocks,
  validFigureDimension, validQuartoLabel } from "../../shared/quarto-references";

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

function inlineProp(obj: Record<string, unknown>, key: string): unknown {
  const props = obj.props as Record<string, unknown> | undefined;
  return props?.[key] ?? obj[key];
}

function containsCustomInline(content: unknown): boolean {
  if (!content) return false;
  if (Array.isArray(content)) return content.some(containsCustomInline);
  if (typeof content === "object" && content !== null) {
    const obj = content as Record<string, unknown>;
    if (["citation", "crossReference", "quartoLiteral", "footnote", "inlineMath"].includes(String(obj.type))) return true;
    if (obj.type === "tableContent") return containsCustomInline(obj.rows);
    if (Array.isArray(obj.cells)) return containsCustomInline(obj.cells);
    return containsCustomInline(obj.content);
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
 * Convert inline content to Markdown with styling preserved.
 */
function inlineContentToMarkdown(content: unknown, format: ExportFormat): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];

    for (let index = 0; index < content.length;) {
      const citation = format === "qmd"
        ? citationToMarkdown(content[index])
        : null;

      if (citation) {
        const citations = [citation];
        index += 1;

        while (index < content.length) {
          const nextCitation = citationToMarkdown(content[index]);
          if (!nextCitation) break;
          citations.push(nextCitation);
          index += 1;
        }

        parts.push(`[${citations.join("; ")}]`);
        continue;
      }

      let part = inlineContentToMarkdown(content[index], format);
      const item = content[index] as Record<string, unknown> | null;
      if (item?.type === "crossReference" && !inlineProp(item, "bracketed")) {
        const before = parts.at(-1) ?? "";
        const after = inlineContentToMarkdown(content[index + 1], format);
        if (/[\p{L}\p{N}_@]$/u.test(before) || /^[\p{L}\p{N}_@]/u.test(after)) part = `[${part}]`;
      }
      parts.push(part);
      index += 1;
    }

    return parts.join("");
  }

  if (typeof content === "object" && content !== null) {
    const obj = content as Record<string, unknown>;
    const text = typeof obj.text === "string" ? obj.text : "";
    const styles = (obj.styles || {}) as Record<string, unknown>;

    // Citation inline: [@citekey]
    if (obj.type === "citation") {
      const citation = citationToMarkdown(obj);
      if (citation) return `[${citation}]`;
    }

    if (obj.type === "crossReference") {
      const label = String(inlineProp(obj, "label") ?? "");
      if (!validQuartoLabel(label)) throw new Error(`Invalid cross-reference: @${label}`);
      const locator = String(inlineProp(obj, "locator") ?? "");
      const reference = `@${label}${locator ? `, ${locator}` : ""}`;
      return inlineProp(obj, "bracketed") ? `[${reference}]` : reference;
    }
    if (obj.type === "quartoLiteral") return String(inlineProp(obj, "source") ?? "");

    // Footnote inline: [^N]
    if (obj.type === "footnote") {
      const index = inlineProp(obj, "index") ?? inlineProp(obj, "number");
      if (typeof index === "number" || typeof index === "string") return `[^${index}]`;
    }

    if (obj.type === "inlineMath") {
      const formula = inlineProp(obj, "formula");
      if (typeof formula === "string") return `$${formula}$`;
    }

    if (obj.type === "link" && typeof obj.href === "string") {
      return `[${inlineContentToMarkdown(obj.content, format)}](${obj.href})`;
    }

    let result = text;

    // Apply styles
    if (styles.bold) result = `**${result}**`;
    if (styles.italic) result = `*${result}*`;
    if (styles.underline) result = `<u>${result}</u>`;
    if (styles.strike) result = `~~${result}~~`;
    if (styles.code) result = `\`${result}\``;

    // Links
    if (obj.type === "link" && typeof obj.href === "string") {
      return `[${result}](${obj.href})`;
    }

    return result;
  }

  return "";
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
  blocks = normalizeQuartoBlocks(blocks);
  if (format === "qmd") {
    // Quarto counts YAML title and a body H1 as separate book headings.
    // Keep the existing H1 (including its identifier) as the sole title.
    let chapter = blocks.find((block) => block.type === "heading" && (block.props.level ?? 1) === 1);
    const isIndex = /(?:^|[/\\])index\.(?:qmd|scholarpen\.json)$/i.test(options.filename ?? "");
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
    let frontmatter = buildQuartoFrontmatter();
    if (collectReferenceTargets(blocks).some((target) => target.type === "heading")) {
      frontmatter = frontmatter.replace("bibliography: references.bib", "bibliography: references.bib\nnumber-sections: true");
    }
    lines.push(frontmatter);
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
    case "math":
      return mathBlockToMarkdown(block, format);

    case "figure":
      return figureBlockToMarkdown(block, format);

    case "abstract":
      return abstractBlockToMarkdown(block, format);

    default:
      if (block.type === "heading" || block.type === "table" || containsCustomInline(block.content)) {
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
      const rows = table.rows.map((row) => `${indent}| ${row.cells.map((cell) => {
        const content = Array.isArray(cell) ? cell : (cell as { content: unknown }).content;
        return inlineContentToMarkdown(content, format).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
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
  const formula = (block.props.formula as string) || "";
  const label = format === "qmd" && typeof block.props.label === "string" && /^eq-[\w:.-]+$/.test(block.props.label)
    ? ` {#${block.props.label}}` : "";
  return `$$\n${formula}\n$$${label}`;
}

function figureBlockToMarkdown(block: Block, format: ExportFormat): string {
  const url = block.props.sourcePath ? figureExportUrl(String(block.props.sourcePath)) : (block.props.url as string) || "";
  const caption = (block.props.caption as string) || "";
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
