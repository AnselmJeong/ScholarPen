import { expect, test } from "bun:test";
import { analyzeAIText, parseDetectorOutput } from "./service";

import { detectionReportFixture as report } from "../../shared/ai-detection.fixture";
test("validates threshold, model identity, coverage, scores and feature positions", () => {
  const parse = (value: unknown) => parseDetectorOutput(JSON.stringify({ ok: true, report: value }));
  expect(parse(report)).toEqual(report);
  for (const patch of [{ version: 1 }, { tokens: -1 }, { thresholdLogit: null }, { revision: "main" }, { windows: [] }]) {
    expect(() => parse({ ...report, ...patch })).toThrow();
  }
  for (const patch of [{ pAi: 1.1 }, { label: "human" }, { start: 1 }, { end: 999 }, { bias: 10 }, { tokens: 0 },
    { features: [{ id: 1, description: "test", importance: 1, spans: [{ start: 0, end: 999, activation: 1 }] }] }]) {
    expect(() => parse({ ...report, windows: [{ ...report.windows[0], ...patch }] })).toThrow();
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

test("subprocess transport rejects missing source coverage and releases its lock on cancellation", async () => {
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "scholarpen-detector-test-"));
  const executable = join(directory, "fake-python");
  const script = join(directory, "response.ts");
  const previous = process.env.SCHOLARPEN_DETECTOR_PYTHON;
  try {
    await writeFile(script, `await Bun.stdin.text();\nawait new Promise(resolve => setTimeout(resolve, 100));\nconsole.log(${JSON.stringify(JSON.stringify({ ok: true, report }))});\n`);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`);
    await chmod(executable, 0o755);
    process.env.SCHOLARPEN_DETECTOR_PYTHON = executable;
    await expect(analyzeAIText("missing original text")).rejects.toThrow("누락");
    const controller = new AbortController();
    const running = analyzeAIText(report.windows[0]!.text, controller.signal);
    await expect(analyzeAIText("another request")).rejects.toThrow("진행 중");
    controller.abort();
    await expect(running).rejects.toThrow();
    expect(await analyzeAIText(report.windows[0]!.text)).toEqual(report);
  } finally {
    if (previous === undefined) delete process.env.SCHOLARPEN_DETECTOR_PYTHON;
    else process.env.SCHOLARPEN_DETECTOR_PYTHON = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker boundary rejects citation highlights even in nested brackets", () => {
  const value = structuredClone(report);
  const window = value.windows[0]!;
  window.text = "A [repeated phrase]here";
  window.end = window.text.length;
  expect(() => parseDetectorOutput(JSON.stringify({ ok: true, report: value }))).toThrow("대괄호");
});
