import { describe, expect, test } from "bun:test";
import { buildDocumentOutline, visibleActiveHeading, visibleOutlineHeadings, type OutlineBlock } from "./document-outline";

const heading = (id: string, level: number, content = id): OutlineBlock => ({ id, type: "heading", props: { level }, content });

describe("document outline", () => {
  test("uses the nearest preceding lower heading level even when levels are skipped", () => {
    const { headings } = buildDocumentOutline([
      heading("intro", 2), heading("detail", 4), heading("next", 3), heading("chapter", 1), heading("deep", 6),
    ]);
    expect(headings.map(({ id, depth, parentId, hasChildren }) => ({ id, depth, parentId, hasChildren }))).toEqual([
      { id: "intro", depth: 0, parentId: null, hasChildren: true },
      { id: "detail", depth: 1, parentId: "intro", hasChildren: false },
      { id: "next", depth: 1, parentId: "intro", hasChildren: false },
      { id: "chapter", depth: 0, parentId: null, hasChildren: true },
      { id: "deep", depth: 1, parentId: "chapter", hasChildren: false },
    ]);
  });

  test("maps body and nested blocks to their current section without treating notes or code as headings", () => {
    const result = buildDocumentOutline([
      { id: "preface", type: "paragraph", content: "Before any heading" }, heading("chapter", 1),
      { id: "note", type: "note", children: [heading("nested", 2), { id: "body", type: "paragraph" }] },
      { id: "code", type: "codeBlock", content: "# Not a heading" }, heading("next", 1),
    ]);
    expect(result.headings.map((item) => item.id)).toEqual(["chapter", "nested", "next"]);
    expect([...result.sectionByBlock]).toEqual([
      ["preface", null], ["chapter", "chapter"], ["note", "chapter"], ["nested", "nested"],
      ["body", "nested"], ["code", "nested"], ["next", "next"],
    ]);
  });

  test("keeps readable inline text and distinct identities for duplicate titles without changing the document", () => {
    const blocks: OutlineBlock[] = [
      { ...heading("one", 2), content: [{ type: "text", text: "상태  ", styles: { bold: true } },
        { type: "inlineMath", props: { formula: "x(t)" } }, { type: "text", text: "\n그리고 " },
        { type: "link", content: [{ type: "text", text: "변화" }] }] },
      heading("two", 2, "Repeated"), heading("three", 2, "Repeated"), heading("empty", 4, " \n "),
    ];
    const original = JSON.stringify(blocks);
    expect(buildDocumentOutline(blocks).headings.map(({ id, title }) => [id, title])).toEqual([
      ["one", "상태 x(t) 그리고 변화"], ["two", "Repeated"], ["three", "Repeated"], ["empty", "Untitled heading"],
    ]);
    expect(JSON.stringify(blocks)).toBe(original);
  });

  test("folding hides descendants and highlights the visible ancestor of the active subsection", () => {
    const { headings } = buildDocumentOutline([heading("chapter", 1), heading("section", 2), heading("detail", 3), heading("next", 1)]);
    const collapsed = new Set(["chapter", "section"]);
    const visible = visibleOutlineHeadings(headings, collapsed);
    expect(visible.map((item) => item.id)).toEqual(["chapter", "next"]);
    expect(visibleActiveHeading(headings, visible, "detail")).toBe("chapter");
    expect(visibleActiveHeading(headings, visible, "deleted")).toBeNull();
    collapsed.delete("chapter");
    expect(visibleOutlineHeadings(headings, collapsed).map((item) => item.id)).toEqual(["chapter", "section", "next"]);
  });

  test("handles empty documents and reconstructs after heading removal or level changes", () => {
    expect(buildDocumentOutline([{ id: "body", type: "paragraph" }]).headings).toEqual([]);
    const initial = [heading("parent", 1), heading("child", 2)];
    expect(buildDocumentOutline(initial).headings[1].parentId).toBe("parent");
    expect(buildDocumentOutline([initial[1]]).headings[0].depth).toBe(0);
    expect(buildDocumentOutline([initial[0], heading("child", 1)]).headings[1].parentId).toBeNull();
  });
});
