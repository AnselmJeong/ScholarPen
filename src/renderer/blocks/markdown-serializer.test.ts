import { describe, expect, test } from "bun:test";
import type { BlockNoteEditor } from "@blocknote/core";
import {
  blocksToScholarMarkdown,
  buildQuartoFrontmatter,
} from "./markdown-serializer";

describe("Quarto export frontmatter", () => {
  test("does not insert blank lines between YAML fields", () => {
    expect(
      buildQuartoFrontmatter("Document", new Date("2026-07-24T00:00:00.000Z")),
    ).toBe(
      [
        "---",
        'title: "Document"',
        'date: "2026-07-24"',
        "bibliography: references.bib",
        "---",
      ].join("\n"),
    );
  });

  test("keeps a single blank line between frontmatter and document body", async () => {
    const editor = {
      blocksToMarkdownLossy: async () => "Body text",
    } as unknown as BlockNoteEditor;
    const blocks = [{
      id: "paragraph-1",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "Body text", styles: {} }],
      children: [],
    }];

    const qmd = await blocksToScholarMarkdown(editor, blocks, "qmd");

    expect(qmd).toContain(
      'bibliography: references.bib\n---\n\nBody text',
    );
    expect(qmd).not.toContain('---\n\ntitle:');
    expect(qmd).not.toContain('title: "Document"\n\ndate:');
  });
});
