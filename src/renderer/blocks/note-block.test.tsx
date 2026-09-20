import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import { blocksToScholarMarkdown } from "./markdown-serializer";
import { prepareMarkdownNotes } from "./markdown-notes";
import { prepareMarkdownMath, remarkRestoreScholarMath } from "./markdown-math";
import { remarkScholarNotes } from "./note-preview";
import { FigureCaption } from "./figure-caption";
import { normalizeFigureCaption } from "./caption-markdown";

const dom = new Window();
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const globals = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "DocumentFragment", "MutationObserver", "DOMParser", "getComputedStyle"] as const;
const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom : Reflect.get(dom, key) });
afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.happyDOM.abort();
});
const { markdownToScholarBlocks } = await import("./markdown-parser");
const { scholarSchema } = await import("./schema");
const { BlockNoteEditor } = await import("@blocknote/core");
const { toggleSelectedNotes } = await import("./note-toolbar-button");
const editor = BlockNoteEditor.create({ schema: scholarSchema });

const source = `::: {.callout-note title="읽는 법" appearance="simple" icon="false"}
**변화율** $\\dot{x}$는 시간에 따른 변화다 [@author2020].

둘째 문단에서 @eq-rule 을 보자.

- $\\theta$는 파라미터다.
- $D$는 잡음이다.

$$
x = \\{a,b\\}
$$ {#eq-note}
:::

일반 문단.
`;
function allNodes(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) return value.flatMap(allNodes);
  return value && typeof value === "object" ? [value, ...Object.values(value).flatMap(allNodes)] : [];
}

test("Note body, title, math, citations and lists survive schema, JSON, QMD and MD round trips", async () => {
  const blocks = await markdownToScholarBlocks(source, editor);
  editor.replaceBlocks(editor.document, blocks as any);
  const saved = JSON.stringify(editor.document);
  const reloaded = BlockNoteEditor.create({ schema: scholarSchema, initialContent: JSON.parse(saved) });
  expect(reloaded.document[0].type).toBe("note");
  expect(reloaded.document[0].props).toMatchObject({ title: "읽는 법" });
  expect(reloaded.document[0].children.map((b) => b.type)).toEqual(["paragraph", "bulletListItem", "bulletListItem", "math"]);
  for (const format of ["qmd", "md"] as const) {
    const exported = await blocksToScholarMarkdown(reloaded, reloaded.document as any, format);
    if (format === "qmd") expect(exported).toContain('.callout-note title="읽는 법" appearance="simple" icon="false"');
    else expect(exported).toContain('> **읽는 법**');
    expect(exported).toContain('**변화율**');
    const imported = await markdownToScholarBlocks(exported, editor);
    const note = imported.find((b) => b.type === "note")!;
    expect(note.props.title).toBe("읽는 법");
    expect(note.children.map((b: any) => b.type)).toEqual(["paragraph", "bulletListItem", "bulletListItem", "math"]);
    expect(allNodes(note).filter((n) => n.type === "inlineMath").map((n) => n.props.formula)).toEqual([String.raw`\dot{x}`, String.raw`\theta`, "D"]);
    expect(allNodes(note).some((n) => n.type === "citation" && n.props.citekey === "author2020")).toBe(true);
  }
  expect(JSON.stringify(reloaded.document)).toBe(saved);
});

test("conversion retains inline formulas, citations and children and can be undone", () => {
  const editor = BlockNoteEditor.create({ schema: scholarSchema, initialContent: [{ type: "paragraph", content: [
    { type: "text", text: "읽는 법. ", styles: { bold: true } },
    { type: "inlineMath", props: { formula: "x^2" } },
    { type: "citation", props: { citekey: "author2020", locator: "" } },
  ], children: [{ type: "paragraph", content: "More" }] }] });
  const original = JSON.stringify(editor.document[0].content);
  editor.setTextCursorPosition(editor.document[0], "start");
  toggleSelectedNotes(editor);
  expect(editor.document[0].type).toBe("note");
  expect(JSON.stringify(editor.document[0].content)).toBe(original);
  expect(editor.document[0].children[0].content).toMatchObject([{ text: "More" }]);
  toggleSelectedNotes(editor);
  expect(editor.document[0].type).toBe("paragraph");
  expect(JSON.stringify(editor.document[0].content)).toBe(original);
});

test("nested callouts and custom title punctuation round trip without swallowing surrounding prose", async () => {
  const title = 'A "quote" & *star*';
  const editor = BlockNoteEditor.create({ schema: scholarSchema, initialContent: [{ type: "note", props: { title }, content: "outer",
    children: [{ type: "note", content: "inner" }] }, { type: "paragraph", content: "outside" }] });
  for (const format of ["qmd", "md"] as const) {
    const exported = await blocksToScholarMarkdown(editor, editor.document as any, format);
    const imported = await markdownToScholarBlocks(exported, editor);
    const note = imported.find((b) => b.type === "note")!;
    expect(note.props.title).toBe(title);
    expect(note.children[0].type).toBe("note");
    expect(imported.at(-1)?.content).toMatchObject([{ text: "outside" }]);
  }
});

test("code examples, ordinary quotes and incomplete callouts are not converted", async () => {
  const untouched = '```markdown\n' + source + '\n```\n\n> **Ordinary heading**\n>\n> text\n\n::: {.callout-note}\nunfinished';
  expect(prepareMarkdownNotes(untouched).notes.size).toBe(0);
  const blocks = await markdownToScholarBlocks(untouched, editor);
  expect(allNodes(blocks).some((b) => b.type === "note")).toBe(false);
});

test("preview shows a note box with rendered math instead of callout syntax", () => {
  const notes = prepareMarkdownNotes(source);
  const math = prepareMarkdownMath(notes.markdown);
  const html = renderToStaticMarkup(<ReactMarkdown
    remarkPlugins={[[remarkRestoreScholarMath, math], [remarkScholarNotes, notes]]}
    rehypePlugins={[rehypeKatex]}>{math.markdown}</ReactMarkdown>);
  expect(html).toContain('<aside class="scholar-note-preview">');
  expect(html).toContain('읽는 법');
  expect(html).toContain('class="katex"');
  expect(html).not.toContain('SCHOLARPEN');
  expect(html).not.toContain('katex-error');
});

test("caption renders the reported legacy double escapes as math and preserves editing source", () => {
  const caption = String.raw`잡음에 의한 탈출. M1($\\theta=0$), $D=0.09$, $x=\\pm0.5$, $1/D$.`;
  const html = renderToStaticMarkup(<FigureCaption caption={caption} />);
  expect(html.match(/class="katex"/g)).toHaveLength(4);
  expect(html).toContain('θ');
  expect(html).toContain('±');
  expect(html).not.toContain('katex-error');
  expect(caption).toContain(String.raw`$\\theta=0$`);
  const matrix = String.raw`$\begin{matrix}a\\b\end{matrix}$`;
  expect(normalizeFigureCaption(matrix)).toBe(matrix);
  const safe = renderToStaticMarkup(<FigureCaption caption={'<script>alert(1)</script> $\\badcommand$'} />);
  expect(safe).not.toContain('<script>');
});

test("caption TeX braces and row separators survive QMD import/export", async () => {
  const caption = String.raw`집합 $\{x\}$와 $\begin{matrix}a\\b\end{matrix}$, **강조**.`;
  const source = `![${caption}](<../figures/plot.png>){#fig-test}`;
  const blocks = await markdownToScholarBlocks(source, editor);
  expect(blocks[0].props.caption).toBe(caption);
  const exported = await blocksToScholarMarkdown(editor, blocks as any, "qmd");
  expect(exported).toContain(`![${caption}]`);
  expect((await markdownToScholarBlocks(exported, editor)).find((b) => b.type === "figure")?.props.caption).toBe(caption);
});
