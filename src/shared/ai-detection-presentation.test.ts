import { expect, test } from "bun:test";
import { detectionPresentation } from "./ai-detection-presentation";
import { bracketedRanges, formatAIDetectionReport } from "./ai-detection";
import { detectionReportFixture } from "./ai-detection.fixture";

test("new and saved paragraph-normalized reports retain scores, directions and source evidence", () => {
  const text = formatAIDetectionReport(detectionReportFixture, "본문");
  for (const saved of [text, text.replace(/\n\n/g, "\n")]) {
    const view = detectionPresentation(saved)!;
    expect(view.threshold).toBe(59.9);
    expect(view.bracketExclusion).toBe(true);
    expect(view.sections[0]).toMatchObject({ flagged: true, score: 73.1 });
    expect(view.sections[0]!.evidence.map(f => f.direction)).toEqual(["ai", "human"]);
    expect(view.sections[0]!.evidence[0]!.excerpts).toContain("**repeated phrase**");
    expect(view.details).toContain("logit > 0.4000");
  }
});

test("threshold equality and tiny differences keep the exact verdict despite rounded scores", () => {
  for (const delta of [-0.000001, 0, 0.000001]) {
    const report = structuredClone(detectionReportFixture);
    const w = report.windows[0]!;
    w.logit = report.thresholdLogit + delta;
    w.pAi = 1 / (1 + Math.exp(-w.logit));
    w.label = delta > 0 ? "ai" : "human";
    const text = formatAIDetectionReport(report, "본문");
    const view = detectionPresentation(text)!;
    expect(view.sections[0]!.flagged).toBe(delta > 0);
    expect(view.sections[0]!.score).toBe(59.9);
    expect(text).toContain(delta ? "0.1점 미만" : "기준과 같음");
  }
});

test("older reports render with their real threshold and a reanalysis notice", () => {
  const old = "**DetectorScope · 본문**\n판정 기준: 구간의 logit이 0.5008보다 클 때\n**구간 1 · AI 신호 기준 이하 · 모델 P(AI) 42.0%**\n- 사람 방향 -0.250 · wording (특징 43)\n> some **text**\n**해석 범위:** research only";
  const view = detectionPresentation(old)!;
  expect(view.sections[0]!.flagged).toBe(false);
  expect(view.threshold).toBeCloseTo(62.2647, 2);
  expect(view.bracketExclusion).toBe(false);
  expect(detectionPresentation("not a report")).toBeNull();
  expect(detectionPresentation(old.replace("42.0%", "999%"))).toBeNull();
});

test("UTF-16 bracket exclusions include nested, multiline, and unclosed spans", () => {
  expect(bracketedRanges("😀a[x[y]\nz]b[]c[unclosed")).toEqual([
    { start: 3, end: 11 }, { start: 12, end: 14 }, { start: 15, end: 24 },
  ]);
});
