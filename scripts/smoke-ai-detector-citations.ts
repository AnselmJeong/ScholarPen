/** Real model check: citekey content/length must not affect inference or highlights. */
import { analyzeAIText } from "../src/bun/ai-detector/service";
import { bracketedRanges, formatAIDetectionReport } from "../src/shared/ai-detection";
const paragraph = "The diagnostic categories changed over time [CITATION]. Kraepelin described several patterns of illness, but later authors questioned whether these patterns represented distinct diseases. We reviewed the historical descriptions alongside recent clinical observations. The available evidence does not establish a single biological boundary between these groups. ";
const texts = ["@pichot1995the", "@dunner1976depressive; @mason2016historical; @ghaemi2002cades"]
  .map(key => "한국어 😀. " + paragraph.repeat(4).replaceAll("CITATION", key));
const reports = [];
for (const text of texts) {
  const report = await analyzeAIText(text);
  if (report.windows.map(w => w.text).join("") !== text) throw new Error("Original source changed");
  const ranges = bracketedRanges(text);
  for (const window of report.windows) for (const feature of window.features) for (const span of feature.spans) {
    if (ranges.some(r => window.start + span.start < r.end && window.start + span.end > r.start)) throw new Error("Citation was highlighted");
  }
  reports.push(report);
}
const signature = (report: typeof reports[number]) => report.windows.map(w => ({ pAi: w.pAi, logit: w.logit, tokens: w.tokens, features: w.features.map(f => [f.id, f.importance]) }));
if (JSON.stringify(signature(reports[0]!)) !== JSON.stringify(signature(reports[1]!))) throw new Error("Citekey changed model result");
console.log(JSON.stringify({ passed: true, threshold: reports[0]!.thresholdLogit, result: signature(reports[0]!) }));
if (process.env.SCHOLARPEN_DETECTOR_SMOKE_OUTPUT) {
  await Bun.write(process.env.SCHOLARPEN_DETECTOR_SMOKE_OUTPUT, JSON.stringify({ report: reports[0], markdown: formatAIDetectionReport(reports[0]!, "인용문 제외 검증") }, null, 2));
}
