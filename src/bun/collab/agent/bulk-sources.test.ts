import { expect, test } from "bun:test";
import { blockNoteText, fitLibrary, fitProjectTexts } from "./bulk-sources";

test("saved BlockNote documents become readable text with citations kept as [@key]", () => {
  expect(blockNoteText([
    { type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Methods" }] },
    { type: "paragraph", content: [{ type: "text", text: "As shown " }, { type: "citation", props: { citekey: "kim2021", locator: "p. 3" } }, { type: "text", text: "." }],
      children: [{ type: "paragraph", content: [{ type: "link", content: [{ type: "text", text: "nested" }] }] }] },
    { type: "math", props: { formula: "x^2" } },
    { type: "table", content: { type: "tableContent", rows: [{ cells: [[{ type: "text", text: "a" }], [{ type: "text", text: "b" }]] }] } },
  ])).toBe("## Methods\n\nAs shown [@kim2021, p. 3].\n\nnested\n\n$$x^2$$\n\na | b");
});

test("short project files stay whole while long ones are excerpted within the budget", () => {
  const fitted = fitProjectTexts([
    { path: "documents/a.scholarpen.json", text: "short" },
    { path: "documents/b.scholarpen.json", text: "x".repeat(10_000) },
    { path: "drafts/notes.md", text: "y".repeat(10_000) },
  ], 6_005);
  expect(fitted[0]).toEqual({ path: "documents/a.scholarpen.json", text: "short", truncated: false });
  expect(fitted[1].truncated).toBe(true);
  expect(fitted[1].text).toContain("middle omitted");
  expect(fitted.reduce((sum, file) => sum + file.text.length, 0)).toBeLessThan(6_200);
  expect(fitProjectTexts([{ path: "drafts/big.md", text: "z".repeat(5_000) }], 500)[0]).toMatchObject({ text: "", omitted: true });
});

test("a large library keeps cited and relevant entries first", () => {
  const entry = (key: string, title: string) => `@article{${key},\n  author = {Doe, J.},\n  title = {${title}},\n  year = {2020}\n}\n`;
  const bibtex = entry("unrelated", "Fish migration") + entry("cited", "Something else") + entry("topical", "Sleep deprivation and memory");
  expect(fitLibrary(bibtex, 10_000, new Set(), "").truncated).toBe(false);
  const fitted = fitLibrary(bibtex, 120, new Set(["cited"]), "Does sleep deprivation impair memory?");
  expect(fitted).toMatchObject({ total: 3, truncated: true });
  expect(fitted.entries.map(line => line.split(":")[0])).toEqual(["cited", "topical"]);
});
