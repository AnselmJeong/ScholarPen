// ── ScholarPen Markdown / Quarto Export Serializer ────────────────
// Converts BlockNote document blocks to Markdown or Quarto (.qmd) format.
// Custom blocks (math, figure, abstract) use format-specific representations.

import type { BlockNoteEditor } from "@blocknote/core";

export type ExportFormat = "md" | "qmd";

interface Block {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content: unknown;
  children: Block[];
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

/**
 * Convert inline content to Markdown with styling preserved.
 */
function inlineContentToMarkdown(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return (content as unknown[]).map(inlineContentToMarkdown).join("");

  if (typeof content === "object" && content !== null) {
    const obj = content as Record<string, unknown>;
    const text = typeof obj.text === "string" ? obj.text : "";
    const styles = (obj.styles || {}) as Record<string, unknown>;

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

    // Citation inline: [@citekey]
    if (obj.type === "citation" && typeof obj.citekey === "string") {
      return `[@${obj.citekey}]`;
    }

    // Footnote inline: [^N]
    if (obj.type === "footnote" && typeof obj.number === "number") {
      return `[^${obj.number}]`;
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
  editor: BlockNoteEditor,
  blocks: Block[],
  format: ExportFormat = "md"
): Promise<string> {
  const lines: string[] = [];

  // Quarto: add YAML frontmatter
  if (format === "qmd") {
    lines.push("---");
    lines.push(`title: "Document"`);
    lines.push(`date: "${new Date().toISOString().split("T")[0]}"`);
    lines.push("bibliography: references.bib");
    lines.push("---");
    lines.push("");
  }

  for (const block of blocks) {
    const md = await blockToMarkdown(editor, block, format, 0);
    lines.push(md);
  }

  return lines.join("\n\n");
}

async function blockToMarkdown(
  editor: BlockNoteEditor,
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
      // Standard blocks: delegate to BlockNote's built-in converter
      try {
        const md = await editor.blocksToMarkdownLossy([block as any]);
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

function mathBlockToMarkdown(block: Block, _format: ExportFormat): string {
  const formula = (block.props.formula as string) || "";
  return `$$\n${formula}\n$$`;
}

function figureBlockToMarkdown(block: Block, format: ExportFormat): string {
  const url = (block.props.url as string) || "";
  const caption = (block.props.caption as string) || "";
  const altText = (block.props.altText as string) || caption || "figure";

  if (format === "qmd" && block.props.figureNumber) {
    // Quarto cross-reference syntax
    const figNum = block.props.figureNumber as number;
    return `![${altText}](${url}){#fig-${figNum}}`;
  }

  return `![${caption || altText}](${url})`;
}

function abstractBlockToMarkdown(block: Block, format: ExportFormat): string {
  const text = inlineContentToMarkdown(block.content);

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