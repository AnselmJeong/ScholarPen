import { expect, test } from "bun:test";
import { analyzeAIText, parseDetectorOutput } from "./service";

const report = { version: 1 as const, score: 0.94, perplexity: 10, tokens: 1000, windows: 4, minScore: 0.8, maxScore: 1.2, hiddenCharacters: 0, characterCounts: {}, observer: "base", performer: "instruct" };
test("validates all numeric metrics at the worker boundary", () => {
  expect(parseDetectorOutput(JSON.stringify({ ok: true, report }))).toEqual(report);
  for (const patch of [{ score: null }, { score: "0.9" }, { windows: 0 }, { tokens: -1 }, { score: 3 }, { minScore: 2 }, { characterCounts: { bidi: -1 } }]) {
    expect(() => parseDetectorOutput(JSON.stringify({ ok: true, report: { ...report, ...patch } }))).toThrow();
  }
});
test("worker failures never become a numeric score", () => {
  expect(() => parseDetectorOutput(JSON.stringify({ ok: false, error: "모델 없음" }))).toThrow("모델 없음");
  expect(() => parseDetectorOutput("NaN")).toThrow();
});
test("empty, oversized and cancelled inputs never launch inference", async () => {
  await expect(analyzeAIText(" ")).rejects.toThrow("분석할");
  await expect(analyzeAIText("x".repeat(100_001))).rejects.toThrow("100,000");
  await expect(analyzeAIText("test", AbortSignal.abort())).rejects.toThrow();
});
