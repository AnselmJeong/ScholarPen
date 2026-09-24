import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { extractValidationResult } from "./validate-analysis";
import {
  buildDeepenAnalysisMessage,
  createDeepenAnalysisRequest,
  extractDeepenProtectedRevision,
  formatDeepenAnalysisForDisplay,
  isDeepenAnalysisMessage,
} from "./deepen-analysis";
import {
  protectSelectionSlice,
  restoreProtectedSelection,
} from "../components/editor/ai-inline-edit-protection";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
    citation: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { citekey: { default: "" }, locator: { default: "" } },
    },
  },
  marks: { bold: {} },
});

describe("Validate selection review", () => {
  test("routes a concise validation request through the protected review pipeline", () => {
    const request = createDeepenAnalysisRequest("선택된 핵심 주장", {
      beforeSelection: "앞부분", afterSelection: "뒷부분",
    }, makeProtection(), "validate");
    expect(request.mode).toBe("validate");
    const message = buildDeepenAnalysisMessage(request);
    expect(message).toStartWith("[ScholarPen Validate]");
    expect(message).toContain("검색된 자료");
    expect(message).toContain("오류가 있을 때만 최소한으로 수정");
    expect(isDeepenAnalysisMessage(message)).toBe(false);
  });

  test("restores a supported correction while preserving citations and bold marks", () => {
    const protection = makeProtection();
    const revision = protection.protectedText.replace("핵심 주장", "수정된 주장");
    const result = extractValidationResult(
      `## 검증 결과\n오류의 근거 [W1]\n\n## Validation verdict\nCORRECTED\n\n## 통합 개선문\n${revision}`,
      protection,
    );
    expect(result.verdict).toBe("CORRECTED");
    const restored = restoreProtectedSelection(schema, protection, result.revision!);
    expect(restored.content.toJSON()).toEqual([
      { type: "text", marks: [{ type: "bold" }], text: "선택된 " },
      { type: "citation", attrs: { citekey: "kim2025", locator: "p. 7" } },
      { type: "text", text: " 수정된 주장" },
    ]);
  });

  for (const verdict of ["UNCHANGED", "UNCERTAIN"] as const) {
    test(`${verdict} never applies even an unexpected replacement section`, () => {
      const protection = makeProtection();
      expect(extractValidationResult(
        `## Validation verdict\n${verdict}\n\n## 통합 개선문\n${protection.protectedText}`,
        protection,
      )).toEqual({ verdict, revision: null });
    });
  }

  test("rejects missing or conflicting verdicts, absent evidence, and incomplete revisions", () => {
    const protection = makeProtection();
    const verdict = "## Validation verdict\nCORRECTED";
    for (const response of [
      "Partial response [W1]",
      `Evidence [W1]\n${verdict}\n\n## Validation verdict\nUNCERTAIN`,
      `${verdict}\n\n## 통합 개선문\n${protection.protectedText}`,
      `Evidence [W1]\n${verdict}\n\n## 통합 개선문\n${protection.markers[0].token}Partial`,
    ]) {
      expect(() => extractValidationResult(response, protection)).toThrow();
    }
  });
});

function makeProtection() {
  const paragraph = schema.nodes.paragraph.create(null, [
    schema.text("선택된 ", [schema.marks.bold.create()]),
    schema.nodes.citation.create({ citekey: "kim2025", locator: "p. 7" }),
    schema.text(" 핵심 주장"),
  ]);
  const doc = schema.nodes.doc.create(null, [paragraph]);
  return protectSelectionSlice(
    doc.slice(1, doc.content.size - 1),
    "선택된 핵심 주장",
    "deepentest",
  );
}

describe("Deepen analysis request", () => {
  test("builds a critique request that automatically applies only the protected revision", () => {
    const protection = makeProtection();
    const request = createDeepenAnalysisRequest("선택된 핵심 주장", {
      beforeSelection: "문서 앞부분",
      afterSelection: "문서 뒷부분",
    }, protection);
    const message = buildDeepenAnalysisMessage(request);

    expect(isDeepenAnalysisMessage(message)).toBe(true);
    expect(message).toContain("선택된 핵심 주장");
    expect(message).toContain("안전하게 자동 반영");
    expect(message).toContain("비판, 반론");
    expect(message).toContain("비약, 모순");
    expect(message).toContain("## 통합 개선문");
    expect(message).toContain("선택문 전체를 다시 작성");
    expect(message).toContain("원문의 언어");
    expect(message).toContain("보호 마커를 정확히 유지");
    expect(message).toContain("자동 반영됩니다");
    expect(message).not.toContain(protection.protectedText);
    expect(message).not.toContain("문서 앞부분");
    expect(message).not.toContain("문서 뒷부분");
  });

  test("extracts and restores the protected integrated revision without losing markup", () => {
    const protection = makeProtection();
    const protectedRevision = protection.protectedText
      .replace("선택된", "심화된")
      .replace("핵심 주장", "핵심 논증");
    const response = `## 분석\n논증을 보완했습니다.\n\n## 통합 개선문\n${protectedRevision}`;

    const extracted = extractDeepenProtectedRevision(response, protection);
    const restored = restoreProtectedSelection(schema, protection, extracted);

    expect(extracted).toBe(protectedRevision);
    expect(restored.content.toJSON()).toEqual([
      { type: "text", marks: [{ type: "bold" }], text: "심화된 " },
      { type: "citation", attrs: { citekey: "kim2025", locator: "p. 7" } },
      { type: "text", text: " 핵심 논증" },
    ]);
  });

  test("renders the Deepen chat without exposing ScholarPen control markers", () => {
    const protection = makeProtection();
    const protectedRevision = protection.protectedText.replace("핵심 주장", "핵심 논증");
    const display = formatDeepenAnalysisForDisplay(
      `## 통합 개선문\n${protectedRevision}`,
      protection,
    );

    expect(display).toContain("선택된 [@kim2025, p. 7] 핵심 논증");
    expect(display).not.toContain("⟦SP:");
  });

  test("rejects a Deepen response whose protected revision is incomplete", () => {
    const protection = makeProtection();
    const incomplete = protection.protectedText.replace(protection.markers.at(-1)!.token, "");

    expect(() => extractDeepenProtectedRevision(
      `## 통합 개선문\n${incomplete}`,
      protection,
    )).toThrow("보호 마커가 불완전");
  });

  test("accepts a conservatively formatted English integrated-revision heading", () => {
    const protection = makeProtection();
    const response = `### **Integrated Revision**:\n${protection.protectedText}`;

    expect(extractDeepenProtectedRevision(response, protection)).toBe(protection.protectedText);
  });

  test("does not classify an ordinary chat message as Deepen", () => {
    expect(isDeepenAnalysisMessage("이 문장을 다듬어 주세요.")).toBe(false);
  });
});
