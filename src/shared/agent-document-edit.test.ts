import { describe, expect, test } from "bun:test";
import {
  DOCUMENT_EDIT_PROTOCOL,
  extractDocumentEdits,
  formatDocumentEdits,
  hasUnfinishedDocumentEdit,
  resolveDocumentEditTarget,
  stripParagraphTags,
} from "./agent-document-edit";
import { manuscriptText, shortParagraphIds } from "./manuscript-text";

const answer = [
  "Methods 2.3절의 표본 문장을 지우고 c의 정의를 고칩니다.",
  '<scholarpen_edit document="documents/Methods_Results.scholarpen.json" summary="표본 추출 문장을 지우고 c를 정의합니다.">',
  '<change paragraph="3f2a9c1e">',
  "<old>표본은 무작위로 추출하였다. </old>",
  "<new></new>",
  "</change>",
  "<change paragraph='[¶a81b0d22]'>",
  "<old>",
  "yielding the coefficient c for each predictor",
  "</old>",
  "<new>",
  "yielding the total association c of each predictor",
  "</new>",
  "</change>",
  "</scholarpen_edit>",
].join("\n");

describe("extractDocumentEdits", () => {
  test("reads the target, summary and each change of a complete block", () => {
    expect(extractDocumentEdits(answer)).toEqual([{
      document: "documents/Methods_Results.scholarpen.json",
      summary: "표본 추출 문장을 지우고 c를 정의합니다.",
      changes: [
        { paragraph: "3f2a9c1e", old: "표본은 무작위로 추출하였다. ", new: "" },
        { paragraph: "a81b0d22", old: "yielding the coefficient c for each predictor", new: "yielding the total association c of each predictor" },
      ],
      malformed: 0,
    }]);
  });

  test("keeps literal angle brackets and quotes in the text", () => {
    const [edit] = extractDocumentEdits('<scholarpen_edit><change paragraph="p1"><old>p < 0.05 for "A"</old><new>p < .05 for “A”</new></change></scholarpen_edit>');
    expect(edit.document).toBe("");
    expect(edit.changes).toEqual([{ paragraph: "p1", old: "p < 0.05 for \"A\"", new: "p < .05 for “A”" }]);
  });

  test("counts malformed changes and skips blocks with nothing in them", () => {
    const [edit] = extractDocumentEdits([
      "<scholarpen_edit>",
      '<change paragraph="p0"></change>',
      '<change paragraph="p1"><new>No old text</new></change>',
      '<change paragraph="p2"><old>  </old><new>x</new></change>',
      '<change paragraph="p3"><old>Kept</old><new/></change>',
      "</scholarpen_edit>",
    ].join("\n"));
    expect(edit.changes).toEqual([{ paragraph: "p3", old: "Kept", new: "" }]);
    expect(edit.malformed).toBe(2);
    expect(extractDocumentEdits("<scholarpen_edit document=\"\">Remove the sampling sentence.</scholarpen_edit>")).toEqual([]);
  });

  test("ignores unfinished blocks and documents beyond the third", () => {
    expect(extractDocumentEdits(answer.slice(0, answer.indexOf("</scholarpen_edit>")))).toEqual([]);
    const block = (n: number) => `<scholarpen_edit document="documents/${n}.scholarpen.json"><change><old>a${n}</old><new>b${n}</new></change></scholarpen_edit>`;
    expect(extractDocumentEdits([1, 2, 3, 4].map(block).join("\n")).map((edit) => edit.document))
      .toEqual(["documents/1.scholarpen.json", "documents/2.scholarpen.json", "documents/3.scholarpen.json"]);
  });

  test("caps one answer at sixty changes", () => {
    const changes = Array.from({ length: 70 }, (_, index) => `<change><old>a${index}</old><new>b${index}</new></change>`).join("");
    const [edit] = extractDocumentEdits(`<scholarpen_edit>${changes}</scholarpen_edit>`);
    expect(edit.changes).toHaveLength(60);
    expect(edit.malformed).toBe(10);
  });
});

describe("formatDocumentEdits", () => {
  test("shows a finished block as a quote of what changes", () => {
    const shown = formatDocumentEdits(answer, "ko");
    expect(shown).not.toContain("<scholarpen_edit");
    expect(shown).not.toContain("<change");
    expect(shown).toContain("> **문서 수정 · Methods\\_Results** — 표본 추출 문장을 지우고 c를 정의합니다.");
    expect(shown).toContain("> - ~~표본은 무작위로 추출하였다.~~\n>   → (삭제)");
    expect(shown).toContain(">   → yielding the total association c of each predictor");
  });

  test("escapes manuscript markup so the quote reads as text", () => {
    const shown = formatDocumentEdits('<scholarpen_edit><change><old>as shown [@kim2020] with $x$</old><new>as *shown*</new></change></scholarpen_edit>', "en", false);
    expect(shown).toContain("~~as shown \\[@kim2020\\] with \\$x\\$~~");
    expect(shown).toContain("→ as \\*shown\\*");
    expect(shown).toContain("**Document edit · current document**");
  });

  test("hides a block while it is still streaming", () => {
    const partial = answer.slice(0, answer.indexOf("</scholarpen_edit>") - 5);
    expect(formatDocumentEdits(partial, "ko")).toBe("Methods 2.3절의 표본 문장을 지우고 c의 정의를 고칩니다.");
    expect(formatDocumentEdits("고칩니다.\n<scholar", "ko")).toBe("고칩니다.");
    expect(formatDocumentEdits("x < y", "en")).toBe("x < y");
  });

  test("keeps an unfinished block visible once the answer is final", () => {
    const cut = "Editing it.\n<scholarpen_edit document=\"\"><change><old>Remove";
    expect(formatDocumentEdits(cut, "en", false)).toBe(cut);
    expect(hasUnfinishedDocumentEdit(cut)).toBe(true);
    expect(hasUnfinishedDocumentEdit(answer)).toBe(false);
  });
});

describe("resolveDocumentEditTarget", () => {
  const project = "/Users/me/ScholarPen/paper";
  const active = `${project}/documents/Intro.scholarpen.json`;

  test("accepts project-relative, mention-style and absolute manuscript paths", () => {
    expect(resolveDocumentEditTarget("documents/Methods_Results.scholarpen.json", `${project}/`, active))
      .toEqual({ ok: true, path: `${project}/documents/Methods_Results.scholarpen.json`, filename: "Methods_Results.scholarpen.json" });
    expect(resolveDocumentEditTarget("@[documents/ch/Two.scholarpen.json]", project, active))
      .toEqual({ ok: true, path: `${project}/documents/ch/Two.scholarpen.json`, filename: "ch/Two.scholarpen.json" });
    expect(resolveDocumentEditTarget(active, project)).toMatchObject({ ok: true, path: active });
  });

  test("an empty target means the active document", () => {
    expect(resolveDocumentEditTarget("", project, active)).toMatchObject({ ok: true, path: active });
    expect(resolveDocumentEditTarget("", project, null)).toEqual({ ok: false, reason: "invalid-target" });
  });

  test("refuses anything outside the project's manuscripts, and response letters", () => {
    for (const target of [
      "documents/../exports/references.bib",
      "documents/../../other/documents/x.scholarpen.json",
      "drafts/notes.scholarpen.json",
      "documents/notes.md",
      "/Users/me/ScholarPen/other/documents/x.scholarpen.json",
    ]) expect(resolveDocumentEditTarget(target, project)).toEqual({ ok: false, reason: "invalid-target" });
    expect(resolveDocumentEditTarget("documents/response-letters/response-2026-11-01-abcd1234.scholarpen.json", project))
      .toEqual({ ok: false, reason: "letter" });
  });
});

describe("paragraph ids in manuscript text", () => {
  const blocks = [
    { id: "3f2a9c1e-0000-4000-8000-000000000001", type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Methods" }], children: [] },
    { id: "a81b0d22-0000-4000-8000-000000000002", type: "paragraph", content: [{ type: "text", text: "Seizures were timed " }, { type: "citation", props: { citekey: "kim2020" } }, { type: "text", text: "." }],
      children: [{ id: "c0ffee00-0000-4000-8000-000000000003", type: "bulletListItem", content: [{ type: "text", text: "Nested point" }], children: [] }] },
    { id: "deadbeef-0000-4000-8000-000000000004", type: "codeBlock", props: { language: "r" }, content: [{ type: "text", text: "lm(y ~ x)" }], children: [] },
    { id: "feedface-0000-4000-8000-000000000005", type: "table", content: { type: "tableContent", rows: [{ cells: [[{ type: "text", text: "A" }]] }] }, children: [] },
  ];

  test("tags each editable paragraph and heading, never code or tables", () => {
    expect(manuscriptText(blocks, { paragraphIds: true })).toBe([
      "[¶3f2a9c1e] ## Methods",
      "[¶a81b0d22] Seizures were timed [@kim2020].",
      "  [¶c0ffee00] - Nested point",
      "```r\nlm(y ~ x)\n```",
      "| A |\n| --- |",
    ].join("\n\n"));
    expect(manuscriptText(blocks)).not.toContain("[¶");
  });

  test("uses the whole id where two blocks share their first eight characters", () => {
    const ids = shortParagraphIds([{ id: "aaaaaaaa-1" }, { id: "aaaaaaaa-2" }, { id: "bbbbbbbb-3" }]);
    expect([...ids.values()]).toEqual(["aaaaaaaa1", "aaaaaaaa2", "bbbbbbbb"]);
  });

  test("tags come off again for requests that cannot edit", () => {
    const text = manuscriptText(blocks, { paragraphIds: true });
    expect(stripParagraphTags(text)).toBe(manuscriptText(blocks));
  });

  test("the protocol explains the ids it relies on", () => {
    expect(DOCUMENT_EDIT_PROTOCOL).toContain("[¶3f2a9c1e]");
    expect(DOCUMENT_EDIT_PROTOCOL).toContain("<old>");
    expect(DOCUMENT_EDIT_PROTOCOL).toContain("never say it is done");
  });
});
