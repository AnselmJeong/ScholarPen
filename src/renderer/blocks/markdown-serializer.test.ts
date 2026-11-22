import { describe, expect, test } from "bun:test";
import type { BlockNoteEditor } from "@blocknote/core";
import { existsSync } from "fs";
import {
  blocksToScholarMarkdown,
  buildQuartoFrontmatter,
  documentTitleFromFilename,
  inlineContentToMarkdown,
  inlineMathToMarkdown,
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
    expect(first).not.toContain("number-sections");
    expect(first).toMatch(/^date: "\d{4}-\d{2}-\d{2}"$/m);
    expect(first).toEndWith("Body text");
    expect(JSON.stringify(blocks)).toBe(original);
  });

  test("makes an opening lower-level heading the chapter title instead of adding the filename", async () => {
    const editor = { blocksToMarkdownLossy: async () => "Body text" } as unknown as BlockNoteEditor;
    const blocks = [
      { id: "blank", type: "paragraph", props: {}, content: [], children: [] },
      { id: "results", type: "heading", props: { level: 2 },
        content: [{ type: "text", text: "Results", styles: {} }], children: [] },
      { id: "patients", type: "heading", props: { level: 2 },
        content: [{ type: "text", text: "Patient characteristics", styles: {} }], children: [] },
      { id: "body", type: "paragraph", props: {},
        content: [{ type: "text", text: "Body text", styles: {} }], children: [] },
    ];
    const before = JSON.stringify(blocks);
    const qmd = await blocksToScholarMarkdown(editor, blocks, "qmd", documentTitleFromFilename("04_results.scholarpen.json"));
    expect(qmd.match(/^#+ .*$/gm)).toEqual(["# Results", "## Patient characteristics"]);
    expect(qmd).not.toContain("# results");
    expect(JSON.stringify(blocks)).toBe(before);
  });

  test("adds the filename title when the opening heading is below the document's top level", async () => {
    const editor = { blocksToMarkdownLossy: async () => "Body text" } as unknown as BlockNoteEditor;
    const blocks = [
      { id: "note", type: "heading", props: { level: 3 },
        content: [{ type: "text", text: "Note", styles: {} }], children: [] },
      { id: "methods", type: "heading", props: { level: 2 },
        content: [{ type: "text", text: "Methods", styles: {} }], children: [] },
    ];
    const qmd = await blocksToScholarMarkdown(editor, blocks, "qmd", "Results");
    expect(qmd.match(/^#+ .*$/gm)).toEqual(["# Results", "### Note", "## Methods"]);
  });

  test("adds the filename title when the document opens with text, not a heading", async () => {
    const editor = { blocksToMarkdownLossy: async () => "Body text" } as unknown as BlockNoteEditor;
    const blocks = [
      { id: "body", type: "paragraph", props: {},
        content: [{ type: "text", text: "Body text", styles: {} }], children: [] },
      { id: "section", type: "heading", props: { level: 2 },
        content: [{ type: "text", text: "Methods", styles: {} }], children: [] },
    ];
    const qmd = await blocksToScholarMarkdown(editor, blocks, "qmd", "Results");
    expect(qmd.match(/^#+ .*$/gm)).toEqual(["# Results", "## Methods"]);
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

describe("Pandoc inline math and styles", () => {
  const editor = { blocksToMarkdownLossy: async () => "" } as unknown as BlockNoteEditor;
  const text = (value: string, styles: Record<string, unknown> = {}) => ({ type: "text", text: value, styles });
  const math = (formula: string) => ({ type: "inlineMath", props: { formula } });
  const reference = (label: string) => ({ type: "crossReference", props: { label, locator: "", bracketed: false } });
  const paragraph = (content: unknown[]) => ({ id: "p", type: "paragraph", props: {}, content, children: [] });

  // The sentence from the report: a formula stored with a trailing space and an
  // italic run that starts with the space after the formula.
  const regressionSentence = [
    text("the coefficient "),
    math("c"),
    text(" for each predictor", { italic: true }),
    text(". Within this regression framework, we defined "),
    math("a \\times b "),
    text(" as the model-based indirect association"),
  ];
  const regressionMarkdown = "the coefficient $c$ *for each predictor*. Within this regression framework, "
    + "we defined $a \\times b$ as the model-based indirect association";

  test("exports the reported sentence as math and emphasis Pandoc can read", async () => {
    const qmd = await blocksToScholarMarkdown(editor, [paragraph(regressionSentence)], "qmd", "Methods");
    expect(qmd).toEndWith(`\n\n${regressionMarkdown}`);
    expect(await blocksToScholarMarkdown(editor, [paragraph(regressionSentence)], "md")).toBe(regressionMarkdown);
  });

  test("trims inline formulas and drops empty ones", () => {
    expect(inlineMathToMarkdown(" x^2 ")).toBe("$x^2$");
    expect(inlineMathToMarkdown("a +\n b")).toBe("$a + b$");
    expect(inlineMathToMarkdown(" \t")).toBe("");
    expect(inlineContentToMarkdown([text("a "), math("  "), text("b")], "qmd")).toBe("a b");
  });

  test("moves whitespace outside style delimiters and never emits an empty styled run", () => {
    expect(inlineContentToMarkdown([text("a"), text(" bold ", { bold: true }), text("b")], "qmd")).toBe("a **bold** b");
    expect(inlineContentToMarkdown([text("a"), text("  ", { italic: true }), text("b")], "qmd")).toBe("a  b");
    expect(inlineContentToMarkdown([text("a"), text("", { strike: true }), text("b")], "qmd")).toBe("ab");
    expect(inlineContentToMarkdown([text("x "), text(" gone\n", { underline: true }), text("y")], "qmd")).toBe("x  <u>gone</u>\ny");
    expect(inlineContentToMarkdown([text(" code ", { code: true })], "qmd")).toBe(" `code` ");
  });

  test("opens and closes styles only where they change between runs", () => {
    expect(inlineContentToMarkdown([text("a ", { italic: true }), text("b", { italic: true, bold: true }), text(" c")], "qmd"))
      .toBe("*a **b*** c");
    expect(inlineContentToMarkdown([text("a", { italic: true, bold: true }), text(" b", { bold: true })], "qmd"))
      .toBe("***a* b**");
    // Runs that differ only in styles Markdown cannot show are one run.
    expect(inlineContentToMarkdown([text("a", { italic: true }), text("b", { italic: true, aiAuthored: true })], "qmd"))
      .toBe("*ab*");
    expect(inlineContentToMarkdown([text("a", { code: true }), text("b", { code: true, textColor: "red" })], "qmd"))
      .toBe("`ab`");
    // A code span stays innermost so other styles are not shown as literal asterisks.
    expect(inlineContentToMarkdown([text("x", { code: true, bold: true })], "qmd")).toBe("**`x`**");
    expect(inlineContentToMarkdown([text("a`b", { code: true })], "qmd")).toBe("``a`b``");
    expect(inlineContentToMarkdown([text("`a", { code: true })], "qmd")).toBe("`` `a ``");
  });

  test("ends styles at math, citations and footnotes", () => {
    expect(inlineContentToMarkdown([text("for ", { italic: true }), math("c"), text(" each", { italic: true })], "qmd"))
      .toBe("*for* $c$ *each*");
    expect(inlineContentToMarkdown([text("see ", { bold: true }), { type: "citation", props: { citekey: "smith2020" } },
      text(".")], "qmd")).toBe("**see** [@smith2020].");
    expect(inlineContentToMarkdown([text("note", { italic: true }), { type: "footnote", props: { index: 1 } },
      text(" more", { italic: true })], "qmd")).toBe("*note*[^1] *more*");
  });

  test("brackets a bare cross-reference that Pandoc would not read as one", () => {
    expect(inlineContentToMarkdown([text("see "), reference("fig-a"), text(".")], "qmd")).toBe("see @fig-a.");
    expect(inlineContentToMarkdown([text("shown", { italic: true }), reference("fig-a")], "qmd")).toBe("*shown*[@fig-a]");
    expect(inlineContentToMarkdown([text("Fig."), reference("fig-a")], "qmd")).toBe("Fig.[@fig-a]");
    expect(inlineContentToMarkdown([text("see "), reference("fig-a"), math("x")], "qmd")).toBe("see [@fig-a]$x$");
    expect(inlineContentToMarkdown([text("see "), reference("fig-a"), text(".5")], "qmd")).toBe("see [@fig-a].5");
    expect(inlineContentToMarkdown([text("see "), reference("fig-a"),
      { type: "citation", props: { citekey: "smith2020" } }], "qmd")).toBe("see [@fig-a][@smith2020]");
  });

  test("escapes table pipes in text only, not in math or code", async () => {
    const table = {
      id: "t", type: "table", props: {}, children: [],
      content: { type: "tableContent", rows: [
        { cells: [[text("Measure")], [text("Value")]] },
        { cells: [[text("a|b "), math("|x|")], [text("c|d", { code: true })]] },
      ] },
    };
    const markdown = await blocksToScholarMarkdown(editor, [table], "md");
    expect(markdown.split("\n")[2]).toBe("| a\\|b $|x|$ | `c|d` |");
  });

  test("keeps display math free of blank lines and drops an empty equation", async () => {
    const equation = (formula: string) => ({ id: "m", type: "math", props: { formula, label: "eq-total" }, content: undefined, children: [] });
    expect(await blocksToScholarMarkdown(editor, [equation("\n a = b \n\n + c \n")], "md")).toBe("$$\n a = b\n + c\n$$");
    expect(await blocksToScholarMarkdown(editor, [equation(" \n ")], "md")).toBe("");
  });

  const quarto = [Bun.which("quarto"), "/usr/local/bin/quarto", "/opt/homebrew/bin/quarto", "/Applications/quarto/bin/quarto"]
    .find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

  test.skipIf(!quarto)("Pandoc reads the exported formulas as math and the styled runs as emphasis", async () => {
    const blocks = [
      paragraph(regressionSentence),
      paragraph([text("Shown", { italic: true }), reference("fig-a"), text(" and "), text("bold ", { bold: true }),
        math(" y "), text(" text", { bold: true, italic: true })]),
      { id: "t", type: "table", props: {}, children: [], content: { type: "tableContent", rows: [
        { cells: [[text("A")], [text("B")]] },
        { cells: [[math("|x|")], [text("p|q")]] },
      ] } },
    ];
    const qmd = await blocksToScholarMarkdown(editor, blocks, "qmd", "Methods");
    const result = Bun.spawnSync([quarto!, "pandoc", "-f", "markdown", "-t", "json"], { stdin: new TextEncoder().encode(qmd) });
    expect(result.exitCode).toBe(0);
    const found = { math: [] as string[], emph: [] as string[], strong: [] as string[], cites: [] as string[], text: [] as string[] };
    const plain = (nodes: any[]): string => nodes.map((node) => node.t === "Str" ? node.c : node.t === "Space" ? " "
      : Array.isArray(node.c) ? plain(node.c.filter((child: unknown) => typeof child === "object")) : "").join("");
    const walk = (node: any): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      if (node.t === "Math") found.math.push(node.c[1]);
      if (node.t === "Emph") found.emph.push(plain(node.c));
      if (node.t === "Strong") found.strong.push(plain(node.c));
      if (node.t === "Cite") found.cites.push(...node.c[0].map((citation: { citationId: string }) => citation.citationId));
      if (node.t === "Str") found.text.push(node.c);
      Object.values(node).forEach(walk);
    };
    walk(JSON.parse(result.stdout.toString()).blocks);
    expect(found.math).toEqual(["c", "a \\times b", "y", "|x|"]);
    expect(found.emph).toEqual(["for each predictor", "Shown", "text"]);
    expect(found.strong).toEqual(["bold", "text"]);
    expect(found.cites).toEqual(["fig-a"]);
    expect(found.text.filter((value) => /[$*]/.test(value))).toEqual([]);
    expect(found.text).toContain("p|q");
  });
});
