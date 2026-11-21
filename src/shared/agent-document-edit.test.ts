import { describe, expect, test } from "bun:test";
import {
  extractDocumentEditRequests,
  formatDocumentEditRequests,
  hasUnfinishedDocumentEditRequest,
  resolveDocumentEditTarget,
} from "./agent-document-edit";

const answer = [
  "Methods_Results 문서에 수정 요청을 보냅니다.",
  '<scholarpen_edit document="documents/Methods_Results.scholarpen.json">',
  "Methods 2.3절에서 \"표본은 무작위로 추출하였다.\" 문장을 삭제하고, 문단이 자연스럽게 이어지도록 다시 써 주세요.",
  "</scholarpen_edit>",
].join("\n");

describe("extractDocumentEditRequests", () => {
  test("reads the target and instruction of each complete block", () => {
    expect(extractDocumentEditRequests(answer)).toEqual([{
      document: "documents/Methods_Results.scholarpen.json",
      instruction: "Methods 2.3절에서 \"표본은 무작위로 추출하였다.\" 문장을 삭제하고, 문단이 자연스럽게 이어지도록 다시 써 주세요.",
    }]);
  });

  test("ignores empty, unfinished and excess blocks", () => {
    const block = (n: number) => `<scholarpen_edit document='documents/${n}.scholarpen.json'>Edit ${n}</scholarpen_edit>`;
    expect(extractDocumentEditRequests("<scholarpen_edit document=\"\">  </scholarpen_edit>")).toEqual([]);
    expect(extractDocumentEditRequests("<scholarpen_edit document=\"\">Remove it")).toEqual([]);
    expect(extractDocumentEditRequests([1, 2, 3, 4].map(block).join("\n")).map(request => request.instruction))
      .toEqual(["Edit 1", "Edit 2", "Edit 3"]);
    expect(extractDocumentEditRequests("<scholarpen_edit>Tighten the abstract.</scholarpen_edit>"))
      .toEqual([{ document: "", instruction: "Tighten the abstract." }]);
  });
});

describe("formatDocumentEditRequests", () => {
  test("shows a finished request as a quote naming the document", () => {
    const shown = formatDocumentEditRequests(answer, "ko");
    expect(shown).not.toContain("<scholarpen_edit");
    expect(shown).toContain("> **ScholarPen AI 수정 요청** · Methods_Results");
    expect(shown).toContain("> Methods 2.3절에서");
  });

  test("hides a request while it is still streaming", () => {
    const partial = answer.slice(0, answer.indexOf("</scholarpen_edit>") - 5);
    expect(formatDocumentEditRequests(partial, "ko")).toBe("Methods_Results 문서에 수정 요청을 보냅니다.");
    expect(formatDocumentEditRequests("요청을 보냅니다.\n<scholar", "ko")).toBe("요청을 보냅니다.");
    expect(formatDocumentEditRequests("x < y", "en")).toBe("x < y");
  });

  test("keeps an unfinished request visible once the answer is final", () => {
    const cut = "Sending it.\n<scholarpen_edit document=\"\">Remove the last sentence";
    expect(formatDocumentEditRequests(cut, "en", false)).toBe(cut);
    expect(hasUnfinishedDocumentEditRequest(cut)).toBe(true);
    expect(hasUnfinishedDocumentEditRequest(answer)).toBe(false);
  });
});

describe("resolveDocumentEditTarget", () => {
  const project = "/Users/me/ScholarPen/paper";
  const active = `${project}/documents/Intro.scholarpen.json`;

  test("accepts project-relative, mention-style and absolute manuscript paths", () => {
    expect(resolveDocumentEditTarget("documents/Methods_Results.scholarpen.json", `${project}/`, active))
      .toBe(`${project}/documents/Methods_Results.scholarpen.json`);
    expect(resolveDocumentEditTarget("@[documents/ch/Two.scholarpen.json]", project, active))
      .toBe(`${project}/documents/ch/Two.scholarpen.json`);
    expect(resolveDocumentEditTarget(active, project)).toBe(active);
  });

  test("an empty target means the active document", () => {
    expect(resolveDocumentEditTarget("", project, active)).toBe(active);
    expect(resolveDocumentEditTarget("", project, null)).toBeNull();
  });

  test("refuses anything outside the project's manuscripts", () => {
    expect(resolveDocumentEditTarget("documents/../exports/references.bib", project)).toBeNull();
    expect(resolveDocumentEditTarget("documents/../../other/documents/x.scholarpen.json", project)).toBeNull();
    expect(resolveDocumentEditTarget("drafts/notes.scholarpen.json", project)).toBeNull();
    expect(resolveDocumentEditTarget("documents/notes.md", project)).toBeNull();
    expect(resolveDocumentEditTarget("/Users/me/ScholarPen/other/documents/x.scholarpen.json", project)).toBeNull();
  });
});
