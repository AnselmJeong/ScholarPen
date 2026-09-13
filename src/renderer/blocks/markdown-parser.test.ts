import { afterAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import { prepareMarkdownMath, remarkRestoreScholarMath } from "./markdown-math";
import { blocksToScholarMarkdown } from "./markdown-serializer";
import { parseBibtexEntries } from "../../shared/bibtex-utils";

const dom = new Window();
// Exercise the real editor and parser; only the native transport is unavailable in Bun.
mock.module("electrobun/view", () => ({ Electroview: class {
  static defineRPC(options: unknown) { return options; }
} }));
const globals = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "DocumentFragment", "MutationObserver", "DOMParser", "getComputedStyle"] as const;
const previousGlobals = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom : (dom as any)[key] });
afterAll(() => {
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as any)[key];
  }
  dom.happyDOM.abort();
});

const { markdownToScholarBlocks } = await import("./markdown-parser");
const { BlockNoteEditor } = await import("@blocknote/core");
const { scholarSchema } = await import("./schema");
const editor = BlockNoteEditor.create({ schema: scholarSchema });

function nodes(value: unknown): any[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(nodes)];
}

const sample = String.raw`---
title: "Math import"
---
# 수식과 인용

함수 $V(\mathbf{x})$와 $\dot{\mathbf{x}} = \mathbf{F}(\mathbf{x})$ [@hopfield1984].

$$\dot{\mathbf{x}} = -\nabla V(\mathbf{x}) + \boldsymbol{\xi}(t)$$ {#eq-gradient-flow}

$$
V_{\mathrm{qs}}(\mathbf{x}) = -\lim_{\epsilon\to 0}\epsilon \log p_{ss}(\mathbf{x})
$$ {#eq-quasipotential-preview}

| 개념 | 수학적 대상 |
| --- | --- |
| 유역 | $\mathcal{B}(A)=\{\mathbf{x}_0\}$ [@hopfield1982; @hopfield1984, p. 42] |

- **강조** $x_y$ 그리고 [@author_with_underscores].
  - 자식 $z$.
`;

describe("Markdown/Quarto math and citation import", () => {
  test("imports the manuscript's inline, display, labelled and table formulas without TeX loss", async () => {
    const blocks = await markdownToScholarBlocks(sample, editor);
    const all = nodes(blocks);
    expect(all.filter((node) => node.type === "math").map((node) => node.props)).toEqual([
      { formula: String.raw`\dot{\mathbf{x}} = -\nabla V(\mathbf{x}) + \boldsymbol{\xi}(t)`, label: "eq-gradient-flow" },
      { formula: String.raw`V_{\mathrm{qs}}(\mathbf{x}) = -\lim_{\epsilon\to 0}\epsilon \log p_{ss}(\mathbf{x})`, label: "eq-quasipotential-preview" },
    ]);
    expect(all.filter((node) => node.type === "inlineMath").map((node) => node.props.formula)).toEqual([
      String.raw`V(\mathbf{x})`, String.raw`\dot{\mathbf{x}} = \mathbf{F}(\mathbf{x})`,
      String.raw`\mathcal{B}(A)=\{\mathbf{x}_0\}`, "x_y", "z",
    ]);
    expect(all.filter((node) => node.type === "citation").map((node) => node.props)).toEqual([
      { citekey: "hopfield1984", locator: "" },
      { citekey: "hopfield1982", locator: "" }, { citekey: "hopfield1984", locator: "p. 42" },
      { citekey: "author_with_underscores", locator: "" },
    ]);
    expect(JSON.stringify(blocks)).not.toContain("SCHOLARPENMATHTOKEN");
    expect(JSON.stringify(blocks)).not.toContain("SCHOLARPENCITATIONTOKEN");
    // Use the actual schema to verify that persistence keeps all custom nodes.
    editor.replaceBlocks(editor.document, blocks as any);
    const saved = JSON.parse(JSON.stringify(editor.document));
    expect(nodes(saved).filter((node) => node.type === "math")[0].props.label).toBe("eq-gradient-flow");
    expect(nodes(saved).filter((node) => node.type === "citation")).toHaveLength(4);
  });

  test("keeps code examples, escaped dollars and citations, currency and image URLs literal", async () => {
    const source = 'Code `$x$ [@code]`, ' + String.raw`escaped \$x\$ and \[@escaped]. $5 and $10; real $y$.

~~~text
$$not math$$
[@not_a_citation]
~~~

![image](figures/$x$.png)
`;
    const blocks = await markdownToScholarBlocks(source, editor);
    expect(nodes(blocks).filter((node) => node.type === "inlineMath").map((node) => node.props.formula)).toEqual(["y"]);
    expect(nodes(blocks).filter((node) => node.type === "citation")).toHaveLength(0);
    expect(JSON.stringify(blocks)).toContain("$5 and $10");
    expect(JSON.stringify(blocks)).toContain("figures/$x$.png");
  });

  test("round-trips formulas, labels and grouped citation locators through QMD", async () => {
    const source = String.raw`Before $x_y$ [@hopfield1982; @hopfield1984, pp. 2-4].

$$x^2$$ {#eq-test}`;
    const imported = await markdownToScholarBlocks(source, editor);
    editor.replaceBlocks(editor.document, imported as any);
    const exported = await blocksToScholarMarkdown(editor, editor.document as any, "qmd");
    expect(exported).toContain("$x_y$");
    expect(exported).toContain("[@hopfield1982; @hopfield1984, pp. 2-4]");
    expect(exported).toContain("$$\nx^2\n$$ {#eq-test}");
    const reimported = await markdownToScholarBlocks(exported, editor);
    expect(nodes(reimported).filter((node) => ["math", "inlineMath", "citation"].includes(node.type)).map((node) => [node.type, node.props]))
      .toEqual(nodes(imported).filter((node) => ["math", "inlineMath", "citation"].includes(node.type)).map((node) => [node.type, node.props]));
  });

  test("preview renders inline, display and table math with KaTeX", () => {
    const prepared = prepareMarkdownMath(sample);
    const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, [remarkRestoreScholarMath, prepared]],
      rehypePlugins: [rehypeKatex], children: prepared.markdown,
    }));
    expect(html.match(/class="katex-display"/g)).toHaveLength(2);
    expect(html.match(/class="katex"/g)).toHaveLength(7);
    expect(html).not.toContain("katex-error");
    expect(html).not.toContain("{#eq-");
    expect(html).not.toContain("SCHOLARPENMATHTOKEN");
  });

  test("keeps table structure and math/citations during export", async () => {
    const blocks = await markdownToScholarBlocks(sample, editor);
    editor.replaceBlocks(editor.document, blocks as any);
    const exported = await blocksToScholarMarkdown(editor, editor.document as any, "qmd");
    const again = nodes(await markdownToScholarBlocks(exported, editor));
    expect(again.filter((node) => node.type === "table")).toHaveLength(1);
    expect(again.filter((node) => node.type === "inlineMath")).toHaveLength(5);
    expect(again.filter((node) => node.type === "citation")).toHaveLength(4);
  });

  const realFixture = process.env.SCHOLARPEN_IMPORT_FIXTURE;
  test.skipIf(!realFixture)("checks the supplied manuscript against its source equations and bibliography", async () => {
    const source = await Bun.file(realFixture!).text();
    const blocks = await markdownToScholarBlocks(source, editor);
    const all = nodes(blocks);
    const display = all.filter((node) => node.type === "math");
    const inline = all.filter((node) => node.type === "inlineMath");
    const citations = all.filter((node) => node.type === "citation");
    expect(display).toHaveLength(2);
    expect(inline).toHaveLength(15);
    expect(citations.some((node) => node.props.citekey === "hopfield1984")).toBe(true);
    const bibliographyPath = realFixture!.slice(0, realFixture!.lastIndexOf("/")) + "/references.bib";
    const bibliography = parseBibtexEntries(await Bun.file(bibliographyPath).text()).entries;
    const keys = new Set(bibliography.map((entry) => entry.citekey));
    expect(citations.filter((node) => !keys.has(node.props.citekey))).toEqual([]);
    const prepared = prepareMarkdownMath(source);
    const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, [remarkRestoreScholarMath, prepared]],
      rehypePlugins: [rehypeKatex], children: prepared.markdown,
    }));
    expect(html).not.toContain("katex-error");
    expect(html.match(/class="katex"/g)).toHaveLength(inline.length + display.length);
    editor.replaceBlocks(editor.document, blocks as any);
    const exported = await blocksToScholarMarkdown(editor, editor.document as any, "qmd");
    const again = nodes(await markdownToScholarBlocks(exported, editor));
    expect(again.filter((node) => node.type === "inlineMath").map((node) => node.props.formula)).toEqual(inline.map((node) => node.props.formula));
    console.log(`Manuscript: ${inline.length} inline equations, ${display.length} display equations, ${citations.length} citations; preview and round-trip passed.`);
  });
});
