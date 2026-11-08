import { detectionReportFixture } from "./ai-detection.fixture";
import { expect, test } from "bun:test";
import { asksForAIScore, detectionInputForRequest, detectionTextFromBlocks, formatAIDetectionReport } from "./ai-detection";

test("explicit Korean/English detection requests route locally, editing and negation do not", () => {
  for (const text of ["/ai-score", "이 문서를 AI가 썼을 가능성을 계산해줘", "AI 작성 확률을 알려줘", "Calculate the AI-generated likelihood of this text"]) expect(asksForAIScore(text)).toBe(true);
  for (const text of ["/humanize", "AI 티를 빼줘", "워터마크 제거해줘", "AI 작성 확률은 계산하지 마", "Do not calculate AI authorship probability", "AI detection 연구를 요약해줘"]) expect(asksForAIScore(text)).toBe(false);
});

test("extracts later and nested prose without code, citation keys, figures or URLs", () => {
  const text = detectionTextFromBlocks([
    { type: "paragraph", content: "EARLY", children: [{ type: "paragraph", content: [{ type: "text", text: "NESTED" }] }] },
    { type: "codeBlock", content: "CODE" },
    { type: "math", props: { formula: "MATH" } },
    { type: "figure", props: { url: "IMAGE" } },
    { type: "paragraph", content: [{ type: "citation", props: { citekey: "CITATION" } }, { type: "link", href: "URL", content: [{ type: "text", text: "LATE" }] }] },
  ]);
  expect(text).toBe("EARLY\n\nNESTED\n\nLATE");
});

test("full snapshot beats truncated LLM context; supplied text beats selection", () => {
  const activeDocument = { path: "doc", content: "truncated", truncated: true };
  const detectionInput = { text: "START" + "x".repeat(60_000) + "END", scope: "document" as const };
  expect(detectionInputForRequest({ message: "/ai-score", activeDocument, detectionInput }).text).toEndWith("END");
  expect(() => detectionInputForRequest({ message: "/ai-score", activeDocument })).toThrow("생략");
  expect(detectionInputForRequest({ message: "/ai-score PASTED", detectionInput }).text).toBe("PASTED");
  expect(detectionInputForRequest({ message: "AI 작성 확률 계산해줘\n\nPASTED", detectionInput }).text).toBe("PASTED");
});

test("shows actual threshold, signed evidence, localized source and model limitations", () => {
  const text = formatAIDetectionReport(detectionReportFixture, "선택 영역");
  expect(text).toContain("DetectorScope");
  expect(text).toContain("0.4000");
  expect(text).toContain("탐지 점수 73.1/100");
  expect(text).toContain("기준 59.9점 · 기준보다 13.2점 높음");
  expect(text).toContain("1개 구간 중 1개가 탐지 기준을 넘었습니다");
  expect(text).toContain("AI 방향 +1.500");
  expect(text).toContain("사람 방향 -0.250");
  expect(text).toContain("**repeated phrase**");
  expect(text).toContain("나머지 1개 특징 +0.250");
  expect(text).toContain("실제 AI 작성 확률이나 AI가 쓴 문장의 비율이 아닙니다");
  expect(text).toContain("한국어·학술 원고");
  expect(text).not.toContain("Binoculars");
});

test("source excerpts cannot inject Markdown images or links", () => {
  const report = structuredClone(detectionReportFixture);
  report.windows[0]!.features[0]!.description = "![tracker](https://example.com) <img src=x>";
  const text = formatAIDetectionReport(report, "본문");
  expect(text).not.toContain("![tracker]");
  expect(text).not.toContain("<img");
});
