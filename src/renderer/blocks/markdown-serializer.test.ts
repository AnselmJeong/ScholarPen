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

describe("Quarto citation export", () => {
  const editor = {
    blocksToMarkdownLossy: async () => "",
  } as unknown as BlockNoteEditor;

  test("merges adjacent citations into one Pandoc citation group", async () => {
    const blocks = [{
      id: "paragraph-1",
      type: "paragraph",
      props: {},
      content: [
        {
          type: "citation",
          props: { citekey: "kaptchuk1998intentional", locator: "" },
        },
        {
          type: "citation",
          props: { citekey: "jutte2012early", locator: "p. 24" },
        },
      ],
      children: [],
    }];

    const qmd = await blocksToScholarMarkdown(editor, blocks, "qmd");

    expect(qmd).toContain(
      "[@kaptchuk1998intentional; @jutte2012early, p. 24]",
    );
    expect(qmd).not.toContain(
      "[@kaptchuk1998intentional][@jutte2012early, p. 24]",
    );
  });

  test("does not merge citations separated by text", async () => {
    const blocks = [{
      id: "paragraph-1",
      type: "paragraph",
      props: {},
      content: [
        { type: "citation", props: { citekey: "first2024", locator: "" } },
        { type: "text", text: " and ", styles: {} },
        { type: "citation", props: { citekey: "second2025", locator: "" } },
      ],
      children: [],
    }];

    const qmd = await blocksToScholarMarkdown(editor, blocks, "qmd");

    expect(qmd).toContain("[@first2024] and [@second2025]");
  });

  test("keeps separate citation groups in ordinary Markdown export", async () => {
    const blocks = [{
      id: "paragraph-1",
      type: "paragraph",
      props: {},
      content: [
        { type: "citation", props: { citekey: "first2024", locator: "" } },
        { type: "citation", props: { citekey: "second2025", locator: "" } },
      ],
      children: [],
    }];

    const markdown = await blocksToScholarMarkdown(editor, blocks, "md");

    expect(markdown).toBe("[@first2024][@second2025]");
  });
});
