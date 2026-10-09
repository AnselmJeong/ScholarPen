import type { AgentStreamParams } from "./rpc-types";

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

export interface AIDetectionReport {
  version: 1;
  score: number;
  perplexity: number;
  tokens: number;
  windows: number;
  minScore: number;
  maxScore: number;
  hiddenCharacters: number;
  characterCounts: Record<string, number>;
  observer: string;
  performer: string;
}

export function formatAIDetectionReport(report: AIDetectionReport, scope: string): string {
  return `AI 작성 가능성 분석 · ${scope}\n\n` +
    `**Binoculars 점수: ${report.score.toFixed(4)}** (낮을수록 AI 생성 텍스트와 유사한 신호)\n\n` +
    `- 분석 범위: ${report.tokens.toLocaleString("en-US")}개 토큰, ${report.windows}개 구간 전체\n` +
    `- 구간별 점수 범위: ${report.minScore.toFixed(4)}–${report.maxScore.toFixed(4)}\n` +
    `- Perplexity: ${report.perplexity.toFixed(2)}\n` +
    `- 숨은 문자·특수 공백 등: ${report.hiddenCharacters}개 (AI 작성의 증거가 아님)\n\n` +
    `현재 모델 쌍은 한국어·영어 학술 원고에 대해 보정되지 않았습니다. 이 점수는 **AI 작성 확률(%)이 아니며**, 사람/AI 판정 기준도 적용하지 않습니다. 짧은 글·비원어민 글·정형화된 학술 문장은 특히 신중하게 해석해야 합니다.\n\n` +
    `모델: ${report.observer} / ${report.performer}. 로컬에서 요청 시점의 텍스트를 분석했으며 원문은 수정하지 않았습니다.`;
}
