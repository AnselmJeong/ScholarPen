import { describe, expect, test } from "bun:test";
import type { BlockNoteEditor } from "@blocknote/core";
import {
  blocksToScholarMarkdown,
  buildQuartoFrontmatter,
  documentTitleFromFilename,
} from "./markdown-serializer";

describe("Quarto export frontmatter", () => {
  test("derives the title from a numbered ScholarPen filename", () => {
    expect(
      documentTitleFromFilename("02 History of Placebo.scholarpen.json"),
    ).toBe("History of Placebo");
    expect(
      documentTitleFromFilename("07. Context Engineering in Neuromodulation.scholarpen.json"),
    ).toBe("Context Engineering in Neuromodulation");
  });

  test("keeps unnumbered filenames and numbers within the title", () => {
    expect(
      documentTitleFromFilename("Placebo 2.0 Results.scholarpen.json"),
    ).toBe("Placebo 2.0 Results");
  });

  test("does not insert blank lines between YAML fields", () => {
    expect(
      buildQuartoFrontmatter(new Date("2026-07-24T00:00:00.000Z")),
    ).toBe(
      [
        "---",
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
      'bibliography: references.bib\n---\n\n# Document\n\nBody text',
    );
    expect(qmd).not.toContain('---\n\ntitle:');
    expect(qmd).not.toContain('title: "Document"\n\ndate:');
  });

  test("uses the filename-derived title in exported QMD", async () => {
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

    const qmd = await blocksToScholarMarkdown(
      editor,
      blocks,
      "qmd",
      documentTitleFromFilename("02 History of Placebo.scholarpen.json"),
    );

    expect(qmd).toContain('# History of Placebo\n\nBody text');
    expect(qmd).not.toMatch(/^title:/m);
  });

  test("keeps a chapter H1 and its section key as the sole title on repeated exports", async () => {
    const editor = { blocksToMarkdownLossy: async () => "Body text" } as unknown as BlockNoteEditor;
    const blocks = [
      { id: "chapter", type: "heading", props: { level: 1, label: "sec-state-space" },
        content: [{ type: "text", text: "상태공간과 동역학", styles: {} }], children: [] },
      { id: "section", type: "heading", props: { level: 2, label: "sec-state-vs-parameter" },
        content: [{ type: "text", text: "상태와 파라미터", styles: {} }], children: [] },
      { id: "body", type: "paragraph", props: {},
        content: [{ type: "text", text: "Body text", styles: {} }], children: [] },
    ];
    const original = JSON.stringify(blocks);
    const first = await blocksToScholarMarkdown(editor, blocks, "qmd", "05 filename fallback");
    expect(first).toBe(await blocksToScholarMarkdown(editor, blocks, "qmd", "05 filename fallback"));
    expect(first).not.toMatch(/^title:/m);
    expect(first.match(/^# /gm)).toHaveLength(1);
    expect(first).toContain("# 상태공간과 동역학 {#sec-state-space}");
    expect(first).toContain("## 상태와 파라미터 {#sec-state-vs-parameter}");
    expect(first).toContain("bibliography: references.bib\nnumber-sections: true");
    expect(first).toMatch(/^date: "\d{4}-\d{2}-\d{2}"$/m);
    expect(first).toEndWith("Body text");
    expect(JSON.stringify(blocks)).toBe(original);
  });

  test("marks an index title unnumbered without changing the source or other headings", async () => {
    const editor = {} as BlockNoteEditor;
    const blocks = [
      { id: "preface", type: "heading", props: { level: 1, label: "sec-preface" }, content: "서문", children: [] },
      { id: "sub", type: "heading", props: { level: 2 }, content: "독자에게", children: [] },
    ];
    const before = JSON.stringify(blocks);
    const qmd = await blocksToScholarMarkdown(editor, blocks, "qmd", "index", { filename: "index.qmd" });
    expect(qmd).toContain("# 서문 {#sec-preface .unnumbered}");
    expect(qmd).toContain("## 독자에게");
    expect(qmd.match(/\.unnumbered/g)).toHaveLength(1);
    expect(qmd).not.toMatch(/^title:/m);
    expect(JSON.stringify(blocks)).toBe(before);
    expect(await blocksToScholarMarkdown(editor, [], "qmd", "서문", { filename: "index.qmd" }))
      .toContain("# 서문 {.unnumbered}");
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
