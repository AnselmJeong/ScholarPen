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

test("never formats raw score as authorship probability or binary verdict", () => {
  const text = formatAIDetectionReport({ version: 1, score: 0.85, perplexity: 12, tokens: 1000, windows: 4, minScore: 0.8, maxScore: 1.1, hiddenCharacters: 2, characterCounts: {}, observer: "base", performer: "instruct" }, "선택 영역");
  expect(text).toContain("0.8500");
  expect(text).toContain("확률(%)이 아니며");
  expect(text).toContain("4개 구간 전체");
  expect(text).not.toContain("85%");
  expect(text).not.toContain("AI 같음");
});
