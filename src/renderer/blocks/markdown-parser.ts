// ── ScholarPen Markdown Import Parser ─────────────────────────────
// Converts Markdown/Quarto content to BlockNote PartialBlock arrays.
// Handles custom block patterns: $$...$$, ::: abstract, ![caption](url){#fig-N}, [@citekey]

import { BlockNoteEditor } from "@blocknote/core";
import { scholarSchema, type ScholarEditor } from "./schema";
import { stripFrontmatter } from "../utils/frontmatter";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBlock = Record<string, any>;

/**
 * Create a headless BlockNoteEditor for parsing markdown
 * without requiring a mounted React component.
 */
function createHeadlessEditor(): ScholarEditor {
  return BlockNoteEditor.create({ schema: scholarSchema }) as ScholarEditor;
}

/**
 * Parse Markdown/Quarto content into ScholarPen BlockNote blocks.
 *
 * @param md - The markdown/quarto content to parse
 * @param editor - Optional BlockNoteEditor instance. If not provided,
 *                 a headless editor is created for parsing.
 *
 * Strategy:
 * 1. Strip YAML frontmatter (if present)
 * 2. Pre-process: convert custom patterns into markdown that BlockNote can parse,
 *    annotating them for post-processing
 * 3. Use BlockNote's built-in parser for standard blocks
 * 4. Post-process: convert annotated blocks back to custom block types
 */
export async function markdownToScholarBlocks(
  md: string,
  editor?: ScholarEditor
): Promise<AnyBlock[]> {
  const parseEditor = editor ?? createHeadlessEditor();

  // Strip frontmatter for Quarto files (or any file with YAML header)
  const processedMd = md.trimStart().startsWith("---") ? stripFrontmatter(md) : md;

  // Pre-process: replace custom patterns with annotated markdown
  const annotated = annotateCustomBlocks(processedMd);

  // Parse using BlockNote's built-in converter
  let blocks: AnyBlock[];
  try {
    blocks = await parseEditor.tryParseMarkdownToBlocks(annotated) as AnyBlock[];
  } catch {
    blocks = (await parseEditor.tryParseMarkdownToBlocks(processedMd) || []) as AnyBlock[];
  }

  // Post-process: convert annotated blocks to custom types
  return postProcessBlocks(blocks);
}

/**
 * Pre-process markdown to annotate custom block patterns so that
 * BlockNote's parser can handle them, and we can convert them back
 * in post-processing.
 */
function annotateCustomBlocks(md: string): string {
  let result = md;

  // 1. Math blocks: $$...$$ → fenced code block with language "math"
  //    BlockNote will parse these as code blocks, which we convert back to math blocks
  result = result.replace(
    /\$\$\n([\s\S]*?)\n\$\$/g,
    (_match, formula: string) => {
      return "```math\n" + formula.trim() + "\n```";
    }
  );

  // 2. Quarto abstract: ::: abstract ... :::
  //    Convert to blockquote with "SCHOLAR_ABSTRACT" marker
  result = result.replace(
    /^::: abstract\n([\s\S]*?)^:::/gm,
    (_match, content: string) => {
      const lines = content.trim().split("\n").map((l: string) => `> ${l}`).join("\n");
      return `> SCHOLAR_ABSTRACT_START\n${lines}\n> SCHOLAR_ABSTRACT_END`;
    }
  );

  // 3. Quarto figure cross-refs: ![alt](url){#fig-N}
  //    Convert to standard image syntax with marker
  result = result.replace(
    /!\[([^\]]*)\]\(([^)]+)\)\{#fig-(\d+)\}/g,
    (_match, alt: string, url: string, figNum: string) => {
      return `![SCHOLAR_FIGURE:${figNum}:${alt}](${url})`;
    }
  );

  return result;
}

/**
 * Post-process parsed blocks to convert annotated standard blocks
 * back to custom ScholarPen block types.
 */
function postProcessBlocks(blocks: AnyBlock[]): AnyBlock[] {
  const result: AnyBlock[] = [];

  for (const block of blocks) {
    // Check for math code blocks
    if (block.type === "codeBlock" || block.type === "code") {
      const props = block.props as Record<string, unknown> | undefined;
      if (props?.language === "math") {
        // Convert to math block
        const formula = extractBlockText(block);
        result.push({
          type: "math",
          props: { formula },
        });
        continue;
      }
    }

    // Check for abstract blockquotes (SCHOLAR_ABSTRACT markers)
    if (block.type === "quote" || block.type === "blockquote") {
      const text = extractBlockText(block);
      if (text.includes("SCHOLAR_ABSTRACT_START")) {
        // Extract content between markers
        const content = text
          .replace(/SCHOLAR_ABSTRACT_START\s*/g, "")
          .replace(/SCHOLAR_ABSTRACT_END\s*/g, "")
          .trim();
        result.push({
          type: "abstract",
          content: content,
        });
        continue;
      }
    }

    // Check for paragraph blocks with abstract markers
    if (block.type === "paragraph") {
      const text = extractBlockText(block);
      if (text === "SCHOLAR_ABSTRACT_START" || text === "SCHOLAR_ABSTRACT_END") {
        // Skip marker paragraphs
        continue;
      }
    }

    // Check for figure blocks (SCHOLAR_FIGURE markers in image alt text)
    if (block.type === "image") {
      const props = block.props as Record<string, unknown> | undefined;
      const alt = (props?.alt as string) || "";
      const url = (props?.url as string) || "";

      const figureMatch = alt.match(/^SCHOLAR_FIGURE:(\d+):(.*)$/);
      if (figureMatch) {
        const figNum = parseInt(figureMatch[1], 10);
        const caption = figureMatch[2];
        result.push({
          type: "figure",
          props: {
            url,
            caption,
            figureNumber: figNum,
            altText: caption || alt,
          },
        });
        continue;
      }
    }

    // Check for paragraph containing only an image with SCHOLAR_FIGURE alt text
    if (block.type === "paragraph") {
      const content = block.content;
      if (Array.isArray(content) && content.length === 1) {
        const firstItem = content[0] as Record<string, unknown>;
        if (firstItem?.type === "image") {
          const alt = (firstItem.alt as string) || "";
          const url = (firstItem.href as string) || "";
          const figureMatch = alt.match(/^SCHOLAR_FIGURE:(\d+):(.*)$/);
          if (figureMatch) {
            const figNum = parseInt(figureMatch[1], 10);
            const caption = figureMatch[2];
            result.push({
              type: "figure",
              props: {
                url,
                caption,
                figureNumber: figNum,
                altText: caption || alt,
              },
            });
            continue;
          }
        }
      }
    }

    // Handle citation inline content: [@citekey]
    if (block.content && Array.isArray(block.content)) {
      block.content = processInlineContent(block.content);
    }

    // Handle children recursively
    if (block.children && Array.isArray(block.children)) {
      block.children = postProcessBlocks(block.children);
    }

    result.push(block);
  }

  return result;
}

/**
 * Process inline content to convert [@citekey] patterns to citation inline content.
 */
function processInlineContent(content: unknown[]): unknown[] {
  return content.map((item: unknown) => {
    if (typeof item === "object" && item !== null) {
      const obj = item as Record<string, unknown>;
      const text = (obj.text as string) || "";

      // Check for citation pattern: [@citekey]
      const citationMatch = text.match(/^\[@(.+)\]$/);
      if (citationMatch) {
        return {
          type: "citation",
          props: { citekey: citationMatch[1] },
          content: undefined,
        };
      }

      // Check for footnote pattern: [^N]
      const footnoteMatch = text.match(/^\[\^(\d+)\]$/);
      if (footnoteMatch) {
        return {
          type: "footnote",
          props: { number: parseInt(footnoteMatch[1], 10) },
          content: undefined,
        };
      }
    }
    return item;
  });
}

/**
 * Extract plain text from a block's content field.
 */
function extractBlockText(block: AnyBlock): string {
  if (!block.content) return "";
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .map((item: unknown) => {
        if (typeof item === "string") return item;
        if (typeof item === "object" && item !== null) {
          const obj = item as Record<string, unknown>;
          return (obj.text as string) || "";
        }
        return "";
      })
      .join("");
  }
  return "";
}