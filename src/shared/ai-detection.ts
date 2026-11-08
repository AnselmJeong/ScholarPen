import type { AgentStreamParams } from "./rpc-types";

export const DETECTION_WINDOW_EXPLANATION = "구간은 모델이 한 번에 읽는 최대 1,024토큰의 본문입니다. 토큰은 단어 또는 단어의 일부이며 글자 수와 다릅니다. 긴 글은 문단·문장 경계와 무관하게 나누어 각 구간을 따로 분석합니다. 대괄호 내용은 제외한 뒤 구간을 나눕니다.";

export function isAIDetectionResult(text: string): boolean {
  return text.startsWith("**DetectorScope ·") || text.startsWith("DetectorScope로 구간별 점수와 원문 근거를 분석하고 있습니다…");
}

/** Drop earlier detection turns only; preserve unrelated conversation. */
export function supersededDetectionMessages(messages: readonly { id: string; role: string; text: string }[]): Set<string> {
  const latest = messages.findLastIndex(message => message.role === "user" && asksForAIScore(message.text));
  const removed = new Set<string>();
  let detectionTurn = false;
  for (let index = 0; index < latest; index++) {
    const message = messages[index]!;
    if (message.role === "user") detectionTurn = asksForAIScore(message.text);
    if (detectionTurn || (message.role === "assistant" && isAIDetectionResult(message.text))) removed.add(message.id);
  }
  return removed;
}

/** Only explicit detection requests are routed away from the writing assistant. */
export function asksForAIScore(text: string): boolean {
  if (/^\s*\/ai-score(?:\s|:|$)/i.test(text)) return true;
  const request = text.split(/\n\s*\n/)[0] ?? "";
  if (/(하지\s*마|말아|않아도|don't|do not|do\s+not)/i.test(request)) return false;
  const subject = /(?:AI|인공지능|chatgpt|GPT|LLM).{0,25}(?:작성|생성|썼|쓴|썼을|확률|가능성|점수|여부|탐지|written|generated|authorship|likelihood|probability|score)/i;
  return subject.test(request) && /계산|검사|측정|분석|알려|판별|확인|추정|calculate|check|detect|estimate|score|assess/i.test(request);
}

/** Prose only; includes nested blocks without serializing citation keys or URLs. */
export function detectionTextFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) throw new Error("문서 텍스트를 읽을 수 없습니다.");
  const inline = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(inline).join("");
    if (!value || typeof value !== "object") return "";
    if ("type" in value && value.type === "text" && "text" in value && typeof value.text === "string") return value.text;
    if ("type" in value && value.type === "link" && "content" in value) return inline(value.content);
    return "";
  };
  const out: string[] = [];
  const walk = (items: unknown[]) => {
    for (const block of items) {
      if (!block || typeof block !== "object") continue;
      if ("type" in block && ["paragraph", "heading", "abstract", "bulletListItem", "numberedListItem", "checkListItem", "quote", "note"].includes(String(block.type)) && "content" in block) {
        const text = inline(block.content);
        if (text.trim()) out.push(text);
      }
      if ("children" in block && Array.isArray(block.children)) walk(block.children);
    }
  };
  walk(blocks);
  return out.join("\n\n");
}

export function detectionInputForRequest(params: Pick<AgentStreamParams, "message" | "detectionInput" | "activeDocument">) {
  const explicit = params.message.match(/^\s*\/ai-score(?:\s+|:\s*)([\s\S]+)$/i)?.[1]?.trim();
  const pasted = params.message.split(/\n\s*\n/).slice(1).join("\n\n").trim();
  let text = explicit || pasted || params.detectionInput?.text;
  const scope = explicit || pasted ? "제공한 텍스트" : params.detectionInput?.scope === "selection" ? "선택한 텍스트" : "현재 문서의 본문";
  if (!text && params.activeDocument) {
    if (params.activeDocument.truncated) throw new Error("문서가 일부 생략되어 분석할 수 없습니다. 편집기에서 /ai-score를 실행해 주세요.");
    text = detectionTextFromBlocks(JSON.parse(params.activeDocument.content));
  }
  if (!text) throw new Error("분석할 문서를 열거나 /ai-score 뒤에 분석할 글을 붙여 주세요.");
  return { text, scope };
}

/** Positions use JavaScript UTF-16 offsets in the analyzed prose snapshot. */
export interface AIDetectionFeature {
  id: number;
  description: string;
  importance: number;
  spans: Array<{ start: number; end: number; activation: number }>;
}

export interface AIDetectionWindow {
  start: number;
  end: number;
  text: string;
  tokens: number;
  pAi: number;
  label: "ai" | "human";
  logit: number;
  bias: number;
  otherContribution: number;
  featureCount: number;
  features: AIDetectionFeature[];
}

export interface AIDetectionReport {
  version: 2;
  engine: "detectorscope";
  model: string;
  revision: string;
  packageVersion: string;
  head: "logreg";
  tau: number;
  thresholdLogit: number;
  tokens: number;
  windows: AIDetectionWindow[];
}

/** UTF-16 source ranges excluded by the worker, including nested/unclosed brackets. */
export function bracketedRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "[") { if (!depth) start = index; depth++; }
    else if (text[index] === "]" && depth && !--depth) ranges.push({ start, end: index + 1 });
  }
  if (depth) ranges.push({ start, end: text.length });
  return ranges;
}

// Excerpts/descriptions are data, never Markdown links, images or HTML.
function literal(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([\\`$*_{}[\]()#+.!|~-])/g, "\\$1").replace(/\s+/g, " ");
}
const signed = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
const score = (value: number) => (value * 100).toFixed(1);

/** Independent lexical check, not an interpretation of a hidden model feature. */
export function repeatedPhraseEvidence(text: string, activationSpans: Array<{ start: number; end: number }>) {
  const excluded = bracketedRanges(text);
  const words = [...text.matchAll(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)]
    .map(match => ({ value: match[0].toLocaleLowerCase("en-US"), start: match.index!, end: match.index! + match[0].length }))
    .filter(word => !excluded.some(range => word.start < range.end && word.end > range.start));
  // Index 3–12-word phrases, never crossing a sentence, line or excluded citation.
  const phrases = new Map<string, { size: number; spans: Array<{ start: number; end: number }> }>();
  for (let start = 0; start < words.length; start++) {
    for (let size = 3; size <= 12 && start + size <= words.length; size++) {
      const slice = words.slice(start, start + size);
      const a = slice[0]!.start, b = slice.at(-1)!.end;
      if (excluded.some(range => a < range.end && b > range.start) ||
        slice.slice(1).some((word, index) => /[.!?;\n]/.test(text.slice(slice[index]!.end, word.start)))) break;
      const key = slice.map(word => word.value).join(" ");
      if (key.length < 12) continue;
      const entry = phrases.get(key) ?? { size, spans: [] };
      if (!entry.spans.length || entry.spans.at(-1)!.end <= a) entry.spans.push({ start: a, end: b });
      phrases.set(key, entry);
    }
  }
  const found = [...phrases.values()].filter(entry => entry.spans.length >= 2 && entry.spans.some(span =>
    activationSpans.some(active => active.start < span.end && active.end > span.start)))
    .sort((a, b) => b.size - a.size || b.spans.length - a.spans.length)[0];
  return found ? { phrase: text.slice(found.spans[0]!.start, found.spans[0]!.end), spans: found.spans } : null;
}

/** Keep nearby activations in one context excerpt instead of duplicating sentences. */
function evidenceExcerpts(text: string, spans: Array<{ start: number; end: number }>): string[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const groups: Array<{ start: number; end: number; spans: typeof sorted }> = [];
  for (const span of sorted) {
    const start = Math.max(0, span.start - 110), end = Math.min(text.length, span.end + 140);
    const previous = groups.at(-1);
    if (previous && start <= previous.end) { previous.end = Math.max(previous.end, end); previous.spans.push(span); }
    else groups.push({ start, end, spans: [span] });
  }
  return groups.slice(0, 2).map(group => {
    let cursor = group.start;
    let excerpt = group.start ? "…" : "";
    for (const span of group.spans) {
      if (span.start < cursor) continue;
      excerpt += literal(text.slice(cursor, span.start));
      const token = text.slice(span.start, span.end);
      excerpt += token.trim() ? `${literal(token.match(/^\s*/)?.[0] ?? "")}**${literal(token.trim())}**${literal(token.match(/\s*$/)?.[0] ?? "")}` : literal(token);
      cursor = span.end;
    }
    return excerpt + literal(text.slice(cursor, group.end)) + (group.end < text.length ? "…" : "");
  });
}

export function formatAIDetectionReport(report: AIDetectionReport, scope: string): string {
  const flagged = report.windows.filter(window => window.label === "ai").length;
  const threshold = 1 / (1 + Math.exp(-report.thresholdLogit));
  const lines = [
    `**DetectorScope · ${scope}**`,
    `분석 완료: ${new Date().toISOString()}`,
    `**${flagged ? "AI 생성 신호 감지" : "AI 탐지 기준 이하"}**`,
    `${report.windows.length}개 구간 중 ${flagged}개가 탐지 기준을 넘었습니다. ${flagged ? "아래에서 해당 구간과 판단 근거를 확인하세요." : "이번 분석에서는 기준을 넘은 구간이 없습니다."}`,
    `탐지 점수는 0–100으로 표시합니다. ${score(threshold)}점 기준을 넘으면 AI 생성 신호로 분류합니다. AI가 작성했다는 확정 판정은 아닙니다.`,
    `인용키를 포함한 대괄호 \\[ ... \\] 안의 내용은 점수와 강조 표시에서 제외했습니다.`,
  ];
  const technical: string[] = [];
  report.windows.forEach((window, index) => {
    const delta = Math.abs(window.pAi - threshold) * 100;
    const difference = delta === 0 ? "기준과 같음" : `기준보다 ${delta < 0.1 ? "0.1점 미만 " : `${delta.toFixed(1)}점 `}${window.label === "ai" ? "높음" : "낮음"}`;
    lines.push(`**구간 ${index + 1} · ${window.label === "ai" ? "AI 생성 신호 감지" : "탐지 기준 이하"} · 탐지 점수 ${score(window.pAi)}/100**`);
    lines.push(`기준 ${score(threshold)}점 · ${difference}${window.tokens < 64 ? " · 짧은 구간: 해석에 주의" : ""}`);
    if (!window.features.length) lines.push("활성 특징이 없어 원문에 표시할 근거가 없습니다.");
    for (const feature of window.features) {
      lines.push(`- ${feature.importance > 0 ? "AI 방향" : "사람 방향"} ${signed(feature.importance)} · ${literal(feature.description)} (특징 ${feature.id})`);
      const repetition = /repeat(?:ed|ing|ition).*?(?:phrase|sequence)/i.test(feature.description)
        ? repeatedPhraseEvidence(window.text, feature.spans) : undefined;
      if (repetition) {
        lines.push(`  본문 확인: ${literal(repetition.phrase)} — 이 구간에서 ${repetition.spans.length}회 반복됩니다. 반복 자체가 오류나 AI 작성의 증거는 아닙니다.`);
        if (window.label === "ai" && feature.importance > 0) lines.push("  수정 검토: 같은 내용을 중복 설명한 경우에만 뒤의 설명을 합치거나 줄이는 것을 검토하세요. 이 수정이 탐지 점수를 낮춘다고 보장할 수는 없습니다.");
        for (const excerpt of evidenceExcerpts(window.text, repetition.spans.slice(0, 3))) lines.push(`  확인 원문: ${excerpt}`);
      } else {
        lines.push(`  본문 확인: ${repetition === null ? "반응 위치를 포함하는 3단어 이상의 반복 구절을 이 구간에서 확인하지 못했습니다." : "이 모델 특징만으로 현재 글에서 고칠 표현을 특정할 수 없습니다."} 강조된 단어를 바꾸라는 뜻은 아닙니다.`);
      }
      if (!feature.spans.length) lines.push("  원문에 대응하는 위치가 없습니다.");
      for (const excerpt of evidenceExcerpts(window.text, feature.spans)) lines.push(`  > ${excerpt}`);
    }
    technical.push(`구간 ${index + 1}: 본문 위치 ${window.start + 1}–${window.end} (UTF-16) · ${window.tokens}토큰 · logit ${window.logit.toFixed(4)}. 기여도 합계: 기본값 ${signed(window.bias)} + 표시한 특징 ${signed(window.features.reduce((sum, feature) => sum + feature.importance, 0))} + 나머지 ${Math.max(0, window.featureCount - window.features.length)}개 특징 ${signed(window.otherContribution)} = logit ${signed(window.logit)}.`);
  });
  lines.push("**분석 상세**");
  lines.push(DETECTION_WINDOW_EXPLANATION);
  lines.push(`판정 기준: logit > ${report.thresholdLogit.toFixed(4)}. 탐지 점수 = sigmoid(logit) × 100. 표시한 점수는 반올림하며, 판정은 반올림 전 값으로 계산합니다. ${report.tokens.toLocaleString("en-US")}개 토큰 분석.`);
  lines.push(...technical);
  lines.push("탐지 점수는 **실제 AI 작성 확률이나 AI가 쓴 문장의 비율이 아닙니다.** 여러 구간을 문서 전체 확률로 합산하지 않습니다. 강조한 표현은 모델의 판단에 영향을 준 위치이며, 해당 문장이 AI가 쓴 문장이라는 뜻은 아닙니다. +는 AI 방향, −는 사람 방향의 기여도입니다. 특징 설명은 모델이 제공한 원문입니다.");
  lines.push("한국어·학술 원고에서의 정확도는 별도로 검증되지 않았으며 오탐할 수 있습니다. 이 결과만으로 저자나 연구윤리를 판단하지 마세요. 긴 글은 구간 경계에 따라 결과가 달라질 수 있습니다.");
  lines.push(`모델: ${report.model} · revision ${report.revision.slice(0, 12)} · DetectorScope ${report.packageVersion} · logreg · 설명 검증 기준 τ=${report.tau.toFixed(2)} (판정 확률 기준과 다름).`);
  lines.push("요청 시점의 본문을 로컬에서 분석했으며 원문은 수정하지 않았습니다. 위치와 인용문은 분석 당시의 스냅샷 기준입니다. [DetectorScope 문서](https://github.com/google-deepmind/detectorscope)");
  return lines.join("\n\n");
}
