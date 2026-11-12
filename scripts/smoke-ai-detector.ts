/** Real offline integration check. Can be bundled and run outside the checkout. */
import { analyzeAIText } from "../src/plugins/ai-writing-score/main/service";
import { formatAIDetectionReport } from "../src/shared/ai-detection";

const passage = "We measured samples on three different days. The first measurement was higher than the second, but the difference was small. Further experiments will be needed to establish whether this pattern is reproducible across laboratories. ";
const text = passage.repeat(40) + "한국어와 이모지 😀도 원문 그대로 보존합니다. END OF MANUSCRIPT.";
const started = Date.now();
const report = await analyzeAIText(text);
if (report.windows.length < 2 || report.windows.map(window => window.text).join("") !== text) throw new Error("Window coverage failed");
if (!report.windows.some(window => window.features.some(feature => feature.spans.length))) throw new Error("No localized evidence");
if (!formatAIDetectionReport(report, "smoke test").includes("END OF MANUSCRIPT") && !report.windows.at(-1)!.text.endsWith("END OF MANUSCRIPT.")) throw new Error("Tail missing");
console.log(JSON.stringify({ engine: report.engine, windows: report.windows.length, tokens: report.tokens,
  thresholdLogit: report.thresholdLogit, scores: report.windows.map(window => window.pAi),
  evidence: report.windows.map(window => window.features.length), elapsedSeconds: (Date.now() - started) / 1000 }));
if (process.env.SCHOLARPEN_DETECTOR_SMOKE_OUTPUT) {
  await Bun.write(process.env.SCHOLARPEN_DETECTOR_SMOKE_OUTPUT, JSON.stringify({ ok: true, report }, null, 2));
}
