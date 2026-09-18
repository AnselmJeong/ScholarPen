import { afterAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { collectDocumentCitationKeys, remapDocumentCitationKeys } from "../../shared/bibtex-utils";
import { blockLabel, collectReferenceTargets, normalizeQuartoBlocks } from "../../shared/quarto-references";
import { blocksToScholarMarkdown } from "./markdown-serializer";
import { referenceSuggestions } from "./reference-suggestions";
import { mergeProjectReferences, documentReferenceTargets } from "../../shared/project-references";

const dom = new Window();
mock.module("electrobun/view", () => ({ Electroview: class { static defineRPC(options: unknown) { return options; } } }));
const globals = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "DocumentFragment", "MutationObserver", "DOMParser", "getComputedStyle"] as const;
const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom : (dom as any)[key] });
afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as any)[key];
  }
  dom.happyDOM.abort();
});
const { markdownToScholarBlocks } = await import("./markdown-parser");
const { scholarSchema } = await import("./schema");
const { BlockNoteEditor } = await import("@blocknote/core");
const editor = BlockNoteEditor.create({ schema: scholarSchema });
test("linked figure paths survive schema reload and relinking preserves metadata in export", async () => {
  const linked = BlockNoteEditor.create({ schema: scholarSchema, initialContent: [{
    id: "linked", type: "figure", props: { sourcePath: "figures/first.png", caption: "Original caption",
      label: "fig-linked", figureNumber: 3, width: "70%", height: "", alignment: "left", altText: "Accessible description" },
  }] });
  linked.updateBlock("linked", { props: { sourcePath: "figures/그림 (2)#.png", url: "" } });
  const saved = JSON.parse(JSON.stringify(linked.document));
  const restored = BlockNoteEditor.create({ schema: scholarSchema, initialContent: saved });
  expect(restored.document[0].props).toMatchObject({ sourcePath: "figures/그림 (2)#.png", caption: "Original caption",
    label: "fig-linked", figureNumber: 3, width: "70%", alignment: "left", altText: "Accessible description" });
  for (const format of ["md", "qmd"] as const) {
    const output = await blocksToScholarMarkdown(restored, restored.document as any, format);
    expect(output).toContain("../figures/");
    expect(output).toContain("%282%29%23.png");
    expect(output).toContain("Original caption");
    expect(output).not.toContain("data:image");
    if (format === "qmd") {
      expect(output).toContain('#fig-linked width="70%" fig-align="left"');
      const imported = await markdownToScholarBlocks(output);
      expect(imported.find((block) => block.type === "figure")?.props.url).toStartWith("../figures/");
    }
  }
});
function nodes(value: any): any[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  return value && typeof value === "object" ? [value, ...Object.values(value).flatMap(nodes)] : [];
}

export const referenceFixture = String.raw`# State {#sec-state}

See @sec-state, @fig-one, @tbl-one and @eq-steady-state. [@fig-one; @smith2020, p. 2].

![Figure caption](<figure.svg>){#fig-one width="50%" height="2cm" fig-align="right" fig-alt="Accessible figure"}

| Name | Value | Note |
| :--- | ---: | :---: |
| A | $x$ | [@eq-steady-state] |

: Table caption {#tbl-one tbl-colwidths="[50,30,20]"}

$$
x = 1
$$ {#eq-steady-state}
`;

describe("Quarto identifiers and layout", () => {
  test("keeps preface classes and section IDs through import, schema, JSON reload and repeated export", async () => {
    const source = '---\ntitle: "Legacy duplicate"\n---\n\n# 서문 {#sec-preface .unnumbered .unlisted}\n\n본문.\n\n## 안내 {#sec-guide}\n';
    let qmd = source;
    for (let pass = 0; pass < 2; pass++) {
      const blocks = await markdownToScholarBlocks(qmd, editor);
      editor.replaceBlocks(editor.document, blocks as any);
      editor.replaceBlocks(editor.document, JSON.parse(JSON.stringify(editor.document)));
      expect(editor.document[0].props).toMatchObject({ label: "sec-preface", quartoClasses: "unnumbered unlisted" });
      qmd = await blocksToScholarMarkdown(editor, editor.document as any, "qmd", "Filename");
      expect(qmd).not.toMatch(/^title:/m);
      expect(qmd.match(/^# /gm)).toHaveLength(1);
      expect(qmd).toContain("# 서문 {#sec-preface .unnumbered .unlisted}");
      expect(qmd).toContain("본문.");
      expect(qmd).toContain("## 안내 {#sec-guide}");
    }
  });

  test("project picker finds unopened chapters by path/title and inserts a real exportable reference", async () => {
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "See " }] as any);
    editor.setTextCursorPosition(editor.document[0], "end");
    const project = mergeProjectReferences([
      { filename: "chapters/steady-state.scholarpen.json", targets: documentReferenceTargets([
        { type: "math", props: { label: "eq-steady-state", formula: "x = 1" } },
        { type: "table", props: { label: "tbl-results", caption: "Measured outcomes" } },
      ]) },
    ], "/book", new Map(), "intro.scholarpen.json", editor.document);
    const items = referenceSuggestions(editor, ["smith2020", "eq-steady-state"], "steady-state.scholarpen", project);
    expect(items).toHaveLength(2);
    expect(items[0].group).toBe("Project references");
    expect(items[0].subtext).toContain("chapters/steady-state.scholarpen.json");
    items[0].onItemClick();
    expect(await blocksToScholarMarkdown(editor, editor.document as any, "qmd")).toContain("[@eq-steady-state]");
    expect([...collectDocumentCitationKeys(editor.document)]).toEqual([]);
    expect(referenceSuggestions(editor, [], "Measured", project)[0].title).toBe("tbl-results");
    expect(referenceSuggestions(editor, ["smith2020"], "smith", project)[0].group).toBe("Citations");
  });

  test("project picker identifies ambiguous labels and reports partial indexing failures", () => {
    const target = { label: "fig-shared", blockId: "x", type: "figure", title: "Caption" };
    const items = referenceSuggestions(editor, [], "fig-shared", {
      targets: [{ ...target, filename: "a.scholarpen.json" }, { ...target, filename: "b.scholarpen.json" }],
      errors: ["broken.scholarpen.json"],
    });
    expect(items[0].subtext).toContain("Duplicate identifier");
    expect(items[1].subtext).toContain("b.scholarpen.json");
    expect(items[2].group).toBe("Reference status");
  });

  test("survive the real schema, JSON reload, export and reimport together", async () => {
    const imported = await markdownToScholarBlocks(referenceFixture, editor);
    editor.replaceBlocks(editor.document, imported as any);
    const saved = JSON.parse(JSON.stringify(editor.document));
    editor.replaceBlocks(editor.document, saved);
    const heading = editor.document.find((block) => block.type === "heading")!;
    expect(heading.props).toMatchObject({ label: "sec-state", level: 1 });
    expect(JSON.stringify(heading.content)).not.toContain("{#");
    const table = editor.document.find((block) => block.type === "table")!;
    expect(table.props).toMatchObject({ label: "tbl-one", caption: "Table caption" });
    expect((table.content as any).columnWidths).toEqual([300, 180, 120]);
    expect((table.content as any).rows[0].cells.map((cell: any) => cell.props.textAlignment)).toEqual(["left", "right", "center"]);
    expect([...collectDocumentCitationKeys(saved)]).toEqual(["smith2020"]);
    expect(nodes(saved).filter((node) => node.type === "crossReference")).toHaveLength(6);
    const exported = await blocksToScholarMarkdown(editor, editor.document as any, "qmd");
    expect(exported).toContain("number-sections: true");
    expect(exported).toContain("# State {#sec-state}");
    expect(exported).toContain('![Figure caption](<figure.svg>){#fig-one width="50%" height="2cm" fig-align="right" fig-alt="Accessible figure"}');
    expect(exported).toContain("| :--- | ---: | :---: |");
    expect(exported).toContain(': Table caption {#tbl-one tbl-colwidths="[50,30,20]"}');
    expect(exported).toContain("[@fig-one; @smith2020, p. 2]");
    expect(exported).toContain("$$\nx = 1\n$$ {#eq-steady-state}");
    const again = await markdownToScholarBlocks(exported, editor);
    editor.replaceBlocks(editor.document, again as any);
    expect(collectReferenceTargets(editor.document).map(({ label }) => label)).toEqual(["sec-state", "fig-one", "tbl-one", "eq-steady-state"]);
    expect((editor.document.find((block) => block.type === "table")!.content as any).columnWidths).toEqual([300, 180, 120]);
  });

  test("editing native heading and table props persists without replacing their native behavior", () => {
    editor.replaceBlocks(editor.document, [
      { type: "heading", props: { level: 4 }, content: "Fourth" },
      { type: "table", content: { type: "tableContent", rows: [{ cells: ["A", "B"] }] } },
    ] as any);
    editor.updateBlock(editor.document[0], { props: { label: "sec-fourth" } });
    editor.updateBlock(editor.document[1], { props: { label: "tbl-native", caption: "Native table" } });
    const saved = JSON.parse(JSON.stringify(editor.document));
    editor.replaceBlocks(editor.document, saved);
    expect(editor.document[0].props).toMatchObject({ label: "sec-fourth", level: 4 });
    expect(editor.document[1].props).toMatchObject({ label: "tbl-native", caption: "Native table" });
    expect(editor.prosemirrorState.schema.nodes.table.spec.tableRole).toBe("table");
    const root = document.createElement("div");
    document.body.appendChild(root);
    try {
      editor.mount(root);
      expect(root.textContent).toContain("Fourth");
      expect(root.textContent).toContain("Native table");
      editor.updateBlock(editor.document[1], { props: { caption: "Changed caption" } });
      expect(root.textContent).toContain("Changed caption");
    } finally {
      editor.unmount();
      root.remove();
    }
  });

  test("retains figure labels after reordering and upgrades legacy references without touching input", async () => {
    const old: any[] = [
      { id: "legacy-figure", type: "figure", props: { figureNumber: 7, caption: "Old", url: "old.png" } },
      { type: "heading", content: [{ type: "text", text: "Old {#sec-old}", styles: {} }], props: { level: 2 } },
      { type: "paragraph", content: [{ type: "citation", props: { citekey: "fig-7", locator: "" } }] },
    ];
    const original = JSON.stringify(old);
    const normalized = normalizeQuartoBlocks(old);
    expect(blockLabel(normalized[0])).toBe("fig-7");
    expect(normalized[1].props.label).toBe("sec-old");
    expect(normalized[2].content[0].type).toBe("crossReference");
    expect(collectDocumentCitationKeys(old).size).toBe(0);
    expect(remapDocumentCitationKeys(old, { "fig-7": "wrong" }).replacementCount).toBe(0);
    expect(JSON.stringify(old)).toBe(original);
    const exported = await blocksToScholarMarkdown(editor, normalized.reverse() as any, "qmd");
    expect(exported).toContain("{#fig-7}");
    expect(exported).toContain("[@fig-7]");
  });

  test("protects code and escaped references, accepts image paths containing parentheses", async () => {
    const source = String.raw`Code \@sec-literal and \[@fig-literal], email name@sec-example.com, ` + '`@eq-code`' + String.raw`.

~~~qmd
# Example {#sec-code}
![Code](code.png){#fig-code}
@sec-code
~~~

![Real](<figures/a(b).png>){#fig-real width=10cm}
`;
    const blocks = await markdownToScholarBlocks(source, editor);
    expect(nodes(blocks).filter((node) => node.type === "crossReference")).toHaveLength(0);
    expect(collectReferenceTargets(blocks as any).map(({ label }) => label)).toEqual(["fig-real"]);
    expect(blocks.find((block) => block.type === "figure")!.props.url).toBe("figures/a(b).png");
    const exported = await blocksToScholarMarkdown(editor, blocks as any, "qmd");
    const again = await markdownToScholarBlocks(exported, editor);
    expect(nodes(again).filter((node) => node.type === "crossReference")).toHaveLength(0);
  });

  test("alignments survive even when the table has no caption or custom inline nodes", async () => {
    const blocks = await markdownToScholarBlocks("| A | B |\n| ---: | :---: |\n| 1 | 2 |", editor);
    editor.replaceBlocks(editor.document, blocks as any);
    const qmd = await blocksToScholarMarkdown(editor, editor.document as any, "qmd");
    expect(qmd).toContain("| ---: | :---: |");
    expect(qmd).not.toContain("SCHOLARPEN");
  });

  test("upgrades a legacy detached table caption without mutating the stored source", () => {
    const original: any[] = [{ type: "table", props: {}, content: { type: "tableContent", rows: [{ cells: [[], []] }] } },
      { type: "paragraph", content: [{ type: "text", text: ': Old caption {#tbl-old tbl-colwidths="[20,80]"}', styles: {} }] }];
    const before = JSON.stringify(original);
    const upgraded = normalizeQuartoBlocks(original);
    expect(upgraded).toHaveLength(1);
    expect(upgraded[0].props).toMatchObject({ label: "tbl-old", caption: "Old caption" });
    expect(upgraded[0].content.columnWidths).toEqual([120, 480]);
    expect(JSON.stringify(original)).toBe(before);
  });

  test("preserves a native image's size and caption when exporting it as a Quarto figure", async () => {
    const image: any = { id: "native", type: "image", props: { url: "image.png", caption: "Native image", previewWidth: 320, textAlignment: "right" } };
    const output = await blocksToScholarMarkdown(editor, [image], "qmd");
    expect(output).toContain('![Native image](<image.png>){width="320px" fig-align="right"}');
    expect(image.type).toBe("image");
  });

  test("reports duplicate labels and invalid dimensions instead of silently corrupting output", async () => {
    const block: any = { id: "one", type: "figure", props: { label: "fig-duplicate", url: "a.png" }, children: [] };
    await expect(blocksToScholarMarkdown(editor, [block, { ...block, id: "two" }], "qmd")).rejects.toThrow("Duplicate Quarto identifiers");
    await expect(blocksToScholarMarkdown(editor, [{ ...block, props: { ...block.props, width: '-5cm' } }], "qmd")).rejects.toThrow("Invalid figure width");
  });

  test("keeps adjacent Korean particles outside a structured reference's key", async () => {
    const blocks: any[] = [{ type: "paragraph", props: {}, content: [
      { type: "text", text: "식", styles: {} },
      { type: "crossReference", props: { label: "eq-state", locator: "", bracketed: false } },
      { type: "text", text: "와 비교한다.", styles: {} },
    ] }];
    const output = await blocksToScholarMarkdown(editor, blocks, "qmd");
    expect(output).toContain("식[@eq-state]와 비교한다.");
    expect(nodes(await markdownToScholarBlocks(output, editor)).find((node) => node.type === "crossReference").props.label).toBe("eq-state");
  });
});
