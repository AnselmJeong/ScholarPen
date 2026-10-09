import { mkdir, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import worker from "./python/worker.py" with { type: "text" };
import hidden from "./python/detector/text_hidden_chars.py" with { type: "text" };
import scorer from "./python/detector/text_ai_score.py" with { type: "text" };
import { detectorHome, detectorPython } from "./runtime";
import type { AIDetectionReport } from "../../shared/ai-detection";

export function parseDetectorOutput(output: string): AIDetectionReport {
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== "object" || !("ok" in value)) throw new Error("탐지기의 응답 형식이 올바르지 않습니다.");
  if (value.ok === false && "error" in value && typeof value.error === "string") throw new Error(value.error);
  if (value.ok !== true || !("report" in value) || !value.report || typeof value.report !== "object") throw new Error("탐지 결과가 없습니다.");
  const report = value.report;
  const numeric = (key: string, integer = false) => {
    const n: unknown = Reflect.get(report, key);
    return typeof n === "number" && Number.isFinite(n) && n >= 0 && (!integer || Number.isInteger(n));
  };
  if (!("version" in report && report.version === 1 &&
    ["score", "perplexity", "minScore", "maxScore"].every(key => numeric(key)) &&
    ["tokens", "windows", "hiddenCharacters"].every(key => numeric(key, true)) &&
    "observer" in report && typeof report.observer === "string" &&
    "performer" in report && typeof report.performer === "string" &&
    "characterCounts" in report && report.characterCounts && typeof report.characterCounts === "object" &&
    Object.values(report.characterCounts).every(n => typeof n === "number" && Number.isInteger(n) && n >= 0))) {
    throw new Error("탐지 점수가 유효하지 않습니다.");
  }
  // All fields crossing the Python process boundary are checked above.
  const validated = report as AIDetectionReport;
  if (validated.tokens < 63 || validated.windows < 1 || validated.minScore > validated.maxScore ||
    validated.score < validated.minScore - 1e-6 || validated.score > validated.maxScore + 1e-6) {
    throw new Error("탐지 결과의 분석 범위가 올바르지 않습니다.");
  }
  return validated;
}

let busy = false;
export async function analyzeAIText(text: string, signal?: AbortSignal): Promise<AIDetectionReport> {
  signal?.throwIfAborted();
  if (typeof text !== "string" || !text.trim()) throw new Error("분석할 문서를 열거나 텍스트를 선택해 주세요.");
  if (text.length > 100_000) throw new Error("100,000자 이하의 텍스트를 선택해 분석해 주세요.");
  if (busy) throw new Error("다른 AI 작성 가능성 분석이 진행 중입니다. 완료 후 다시 요청해 주세요.");
  busy = true;
  try {
    const python = detectorPython();
    try { await access(python); } catch {
      throw new Error("로컬 탐지기 초기 설정이 필요합니다. ScholarPen 저장소에서 bun run setup:ai-detector를 실행해 주세요.");
    }
    // Embedded sources work in packaged apps, independent of the checkout/cwd.
    const hash = createHash("sha256").update(worker + hidden + scorer).digest("hex").slice(0, 16);
    const root = join(detectorHome, "workers", hash);
    await mkdir(join(root, "detector"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "worker.py"), worker),
      writeFile(join(root, "detector", "__init__.py"), ""),
      writeFile(join(root, "detector", "text_hidden_chars.py"), hidden),
      writeFile(join(root, "detector", "text_ai_score.py"), scorer),
    ]);
    signal?.throwIfAborted();
    const proc = Bun.spawn([python, join(root, "worker.py")], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", TOKENIZERS_PARALLELISM: "false", PYTHONUNBUFFERED: "1" },
    });
    let timedOut = false;
    const abort = () => proc.kill();
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, 10 * 60_000);
    signal?.addEventListener("abort", abort, { once: true });
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
      return report;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (proc.exitCode === null) { proc.kill(); await proc.exited; }
    }
  } finally { busy = false; }
}
