import React from "react";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AIDetectionResult } from "./AIDetectionResult";
import { formatAIDetectionReport } from "../../../shared/ai-detection";
import { detectionReportFixture } from "../../../shared/ai-detection.fixture";

test("saved detection report renders exact evidence in bold without loading source images", () => {
  const text = formatAIDetectionReport(detectionReportFixture, "현재 문서");
  const html = renderToStaticMarkup(<AIDetectionResult text={text} />);
  expect(html).toContain("<strong>repeated phrase</strong>");
  expect(html).toContain("<blockquote>");
  expect(html).toContain("0.4000");
  expect(html).toContain("DetectorScope analysis");
  expect(renderToStaticMarkup(<AIDetectionResult text="![image](https://example.com/pixel) <script>bad</script>" />)).not.toContain("<img");
});

test("tokens that include leading whitespace still highlight the original word", () => {
  const report = structuredClone(detectionReportFixture);
  report.windows[0]!.features[0]!.spans = [{ start: 1, end: 10, activation: 2 }];
  const html = renderToStaticMarkup(<AIDetectionResult text={formatAIDetectionReport(report, "본문")} />);
  expect(html).toContain("<strong>repeated</strong>");
});

test("saved comment paragraph separators remain readable", () => {
  const stored = formatAIDetectionReport(detectionReportFixture, "본문").replace(/\n\n/g, "\n");
  const html = renderToStaticMarkup(<AIDetectionResult text={stored} />);
  expect(html.match(/<p>/g)!.length).toBeGreaterThan(8);
  expect(html).toContain("<strong>repeated phrase</strong>");
});

test("window and feature selection update verdict, gauge and source; technical details start collapsed", async () => {
  const { Window } = await import("happy-dom");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const dom = new Window();
  const keys = ["window", "document", "navigator", "HTMLElement", "Event", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom : Reflect.get(dom, key) });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    const report = structuredClone(detectionReportFixture);
    const human = structuredClone(report.windows[0]!);
    human.label = "human"; human.logit = -1; human.pAi = 1 / (1 + Math.exp(1));
    report.windows.push(human);
    const text = formatAIDetectionReport(report, "본문");
    await act(async () => root.render(<AIDetectionResult text={text} />));
    expect(host.textContent).toContain("2개 구간 중 1개");
    expect(host.querySelector("details")?.open).toBe(false);
    expect(host.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("73.1");
    const click = async (label: string) => {
      const button = [...host.querySelectorAll("button")].find(button => button.textContent?.includes(label))!;
      expect(button).toBeDefined();
      await act(async () => button.click());
    };
    expect([...host.querySelectorAll("button")].some(button => button.textContent?.includes("다시 분석"))).toBe(false);
    expect(host.textContent).toContain("1,024토큰");
    expect(host.textContent).toContain("64토큰");
    expect(host.textContent).toContain("분석 완료");
    await click("conversational wording");
    expect(host.querySelector('[aria-label="선택한 특징의 원문 근거"] strong')?.textContent).toBe("here");
    await click("2구간");
    expect(host.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("26.9");
    expect(host.querySelector('[role="meter"]')?.getAttribute("aria-valuetext")).toContain("기준 이하");
    expect(host.querySelector('[aria-label="선택한 특징의 원문 근거"] strong')?.textContent).toBe("repeated phrase");
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    dom.happyDOM.abort();
  }
});

test("legacy citation highlights and scores are hidden without a reanalysis prompt", () => {
  const old = "**DetectorScope · 본문**\n판정 기준: 구간의 logit이 0.5008보다 클 때\n**구간 1 · AI 신호 기준 초과 · 모델 P(AI) 80.0%**\n- AI 방향 +1.500 · repeated words (특징 1)\n> insanity \\[@pichot1995**the**\\]";
  const html = renderToStaticMarkup(<AIDetectionResult text={old} />);
  expect(html).toContain("이전 분석 방식으로 저장된 결과");
  expect(html).not.toContain("다시 분석");
  expect(html).not.toContain('role="meter"');
  expect(html).not.toContain("pichot1995");
  expect(html).not.toContain("<strong>the</strong>");
});
