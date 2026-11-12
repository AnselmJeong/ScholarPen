import { runExtensionTask } from "../../../bun/extensions/runtime";
import { access } from "node:fs/promises";
import { join } from "node:path";
import config from "./python/detector_config.json";
import { materializeDetectorSources, detectorOfflineEnv } from "./sources";
import { detectorActivity, detectorPython } from "./runtime";
import { bracketedRanges, type AIDetectionReport } from "../../../shared/ai-detection";

export function parseDetectorOutput(output: string): AIDetectionReport {
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== "object" || !("ok" in value)) throw new Error("탐지기의 응답 형식이 올바르지 않습니다.");
  if (value.ok === false && "error" in value && typeof value.error === "string") throw new Error(value.error);
  if (value.ok !== true || !("report" in value) || !value.report || typeof value.report !== "object") throw new Error("탐지 결과가 없습니다.");
  const report = value.report;
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const integer = (value: unknown): value is number => finite(value) && Number.isInteger(value) && value >= 0;
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (!record(report) || report.version !== 2 || report.engine !== "detectorscope" ||
    report.model !== config.model || report.revision !== config.revision || report.packageVersion !== config.packageVersion ||
    report.head !== config.head || report.tau !== config.tau || !finite(report.thresholdLogit) ||
    !integer(report.tokens) || report.tokens < 64 || !Array.isArray(report.windows) || !report.windows.length) {
    throw new Error("DetectorScope 결과 형식이 유효하지 않습니다.");
  }
  let end = 0;
  let tokens = 0;
  for (const window of report.windows) {
    if (!record(window) || !integer(window.start) || window.start !== end || !integer(window.end) ||
      typeof window.text !== "string" || !window.text.length || window.end !== window.start + window.text.length ||
      !integer(window.tokens) || window.tokens < 1 || window.tokens > 1024 ||
      !finite(window.pAi) || window.pAi < 0 || window.pAi > 1 ||
      !finite(window.logit) || !finite(window.bias) || !finite(window.otherContribution) ||
      window.label !== (window.logit > report.thresholdLogit ? "ai" : "human") ||
      Math.abs(window.pAi - 1 / (1 + Math.exp(-window.logit))) > 1e-5 ||
      !integer(window.featureCount) || !Array.isArray(window.features) ||
      window.features.length > 5 || window.featureCount < window.features.length) {
      throw new Error("DetectorScope 구간 점수 또는 분석 범위가 유효하지 않습니다.");
    }
    let contributions = window.bias + window.otherContribution;
    const ids = new Set<number>();
    for (const feature of window.features) {
      if (!record(feature) || !integer(feature.id) || ids.has(feature.id) ||
        typeof feature.description !== "string" || !feature.description.trim() ||
        !finite(feature.importance) || feature.importance === 0 || !Array.isArray(feature.spans) || feature.spans.length > 3) {
        throw new Error("DetectorScope 특징 정보가 유효하지 않습니다.");
      }
      ids.add(feature.id);
      contributions += feature.importance;
      for (const span of feature.spans) {
        if (!record(span) || !integer(span.start) || !integer(span.end) || span.start >= span.end ||
          span.end > window.text.length || !finite(span.activation) || span.activation <= 0) {
          throw new Error("DetectorScope 원문 위치가 유효하지 않습니다.");
        }
      }
    }
    if (Math.abs(contributions - window.logit) > 0.001 * Math.max(1, Math.abs(window.logit))) {
      throw new Error("DetectorScope 특징 기여도 합계가 점수와 일치하지 않습니다.");
    }
    end = window.end;
    tokens += window.tokens;
  }
  if (tokens !== report.tokens || end > 100_000) throw new Error("DetectorScope 분석 범위가 올바르지 않습니다.");
  // All nested fields and model identity are validated at the process boundary.
  const validated = report as unknown as AIDetectionReport;
  const excluded = bracketedRanges(validated.windows.map(window => window.text).join(""));
  for (const window of validated.windows) {
    for (const feature of window.features) {
      if (feature.spans.some(span => excluded.some(range =>
        window.start + span.start < range.end && window.start + span.end > range.start))) {
        throw new Error("DetectorScope 근거에 분석에서 제외한 대괄호 내용이 포함되어 있습니다.");
      }
    }
  }
  return validated;
}

export function analyzeAIText(text: string, signal?: AbortSignal): Promise<AIDetectionReport> {
  return runExtensionTask("scholarpen.ai-writing-score", scopedSignal => analyzeText(text, scopedSignal), signal);
}

async function analyzeText(text: string, signal?: AbortSignal): Promise<AIDetectionReport> {
  signal?.throwIfAborted();
  if (typeof text !== "string" || !text.trim()) throw new Error("분석할 문서를 열거나 텍스트를 선택해 주세요.");
  if (text.length > 100_000) throw new Error("100,000자 이하의 텍스트를 선택해 분석해 주세요.");
  if (detectorActivity.installing) throw new Error("DetectorScope 설치가 진행 중입니다. 완료 후 분석을 다시 실행해 주세요.");
  if (detectorActivity.analyzing) throw new Error("다른 AI 작성 가능성 분석이 진행 중입니다. 완료 후 다시 요청해 주세요.");
  detectorActivity.analyzing = true;
  try {
    const python = detectorPython();
    try { await access(python); } catch {
      throw new Error("DetectorScope 설치가 필요합니다. Settings 또는 분석 패널의 설치·다운로드 버튼을 눌러 주세요.");
    }
    const root = await materializeDetectorSources();
    signal?.throwIfAborted();
    const proc = Bun.spawn([python, join(root, "worker.py")], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: detectorOfflineEnv(),
    });
    let timedOut = false;
    const abort = () => { proc.kill(); };
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, 10 * 60_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      // Drain both streams from the start, even if a worker fails while reading stdin.
      const output = new Response(proc.stdout).text();
      const errors = new Response(proc.stderr).text();
      await proc.stdin.write(JSON.stringify({ text }));
      await proc.stdin.end();
      const [stdout, , code] = await Promise.all([output, errors, proc.exited]);
      signal?.throwIfAborted();
      if (timedOut) throw new Error("분석이 10분을 초과했습니다. 더 짧은 범위를 선택해 주세요.");
      if (!stdout.trim()) throw new Error(`로컬 탐지기가 종료되었습니다 (종료 코드 ${code}).`);
      const report = parseDetectorOutput(stdout);
      if (code !== 0) throw new Error(`로컬 탐지기가 비정상 종료되었습니다 (종료 코드 ${code}).`);
      if (report.windows.map(window => window.text).join("") !== text) {
        throw new Error("DetectorScope 결과에 원문 일부가 누락되었거나 변경되었습니다.");
      }
      return report;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (proc.exitCode === null) { proc.kill(); await proc.exited; }
    }
  } finally { detectorActivity.analyzing = false; }
}
