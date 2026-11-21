import { expect, test } from "bun:test";
import { manuscriptText } from "./manuscript-text";
import { snapshotActiveDocument } from "./active-document-context";

const cell = (text: string) => ({ type: "tableCell", props: { colspan: 1 }, content: [{ type: "text", text, styles: {} }] });

test("a manuscript becomes Markdown-like text that keeps its structure", () => {
  expect(manuscriptText([
    { id: "h", type: "heading", props: { level: 2, label: "sec-results" }, content: [{ type: "text", text: "Results", styles: {} }], children: [] },
    { type: "paragraph", content: [{ type: "text", text: "Remission was common " }, { type: "citation", props: { citekey: "kim2021", locator: "p. 3" } }, { type: "text", text: "." }],
      children: [{ type: "bulletListItem", content: [{ type: "text", text: "nested point" }] }] },
    { type: "table", props: { caption: "Baseline characteristics", label: "tbl-base" }, content: { type: "tableContent", headerRows: 1, rows: [
      { cells: [cell("Characteristic"), cell("n | %")] },
      { cells: [cell("Female"), cell("62")] },
    ] } },
    { type: "divider", props: {}, children: [] },
    { type: "math", props: { formula: "x^2" } },
    { type: "aiPlaceholder", props: { intent: "Write the discussion" } },
    { type: "numberedListItem", content: "first" },
  ])).toBe([
    "## Results {#sec-results}",
    "Remission was common [@kim2021, p. 3].",
    "  - nested point",
    "Table: Baseline characteristics {#tbl-base}\n\n| Characteristic | n \\| % |\n| --- | --- |\n| Female | 62 |",
    "---",
    "$$x^2$$",
    "1. first",
  ].join("\n\n"));
});

test("the live snapshot is text, so a table-heavy document fits whole", () => {
  const rows = Array.from({ length: 25 }, (_, row) => ({ cells: Array.from({ length: 6 }, (_, col) => ({
    ...cell(`r${row}c${col}`), props: { colspan: 1, rowspan: 1, backgroundColor: "default", textColor: "default", textAlignment: "left" },
  })) }));
  const blocks = [
    ...Array.from({ length: 12 }, () => ({ type: "table", props: { textColor: "default" }, content: { type: "tableContent", columnWidths: [], headerRows: 1, rows } })),
    { type: "paragraph", content: [{ type: "text", text: "Old results above." }] },
    { type: "divider", props: {} },
    { type: "paragraph", content: [{ type: "text", text: "New results below." }] },
  ];
  const snapshot = snapshotActiveDocument("documents/04_results.scholarpen.json", blocks);
  expect(snapshot.truncated).toBe(false);
  expect(snapshot.content).toContain("Old results above.\n\n---\n\nNew results below.");
  expect(snapshot.content).not.toContain("tableCell");
});
