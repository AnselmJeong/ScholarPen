/** Read the portable Markdown report, including reports already saved in comments.
 * No hidden payload: copied/exported comments remain readable outside ScholarPen.
 */
export interface DetectionEvidence {
  direction: "ai" | "human";
  contribution: string;
  description: string;
  excerpts: string;
  verification: string;
  verifiedExcerpts: string;
}
export interface DetectionSection {
  number: number;
  flagged: boolean;
  score: number;
  comparison: string;
  evidence: DetectionEvidence[];
  tokens?: number;
}
export interface DetectionPresentation {
  scope: string;
  threshold: number;
  bracketExclusion: boolean;
  sections: DetectionSection[];
  details: string;
  completedAt?: string;
}

export function detectionPresentation(text: string): DetectionPresentation | null {
  if (!text.startsWith("**DetectorScope ·")) return null;
  const heading = /^\*\*구간 (\d+) · (.*?) · (?:탐지 점수 ([\d.]+)\/100|모델 P\(AI\) ([\d.]+)%)\*\*$/;
  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const sections: DetectionSection[] = [];
  const details: string[] = [];
  let section: DetectionSection | undefined;
  let evidence: DetectionEvidence | undefined;
  let technical = false;
  for (const line of lines) {
    const match = line.match(heading);
    if (match) {
      const score = Number(match[3] ?? match[4]);
      if (!Number.isFinite(score) || score < 0 || score > 100) return null;
      section = { number: Number(match[1]), flagged: /감지|초과/.test(match[2]!), score, comparison: "", evidence: [] };
      sections.push(section);
      evidence = undefined;
    } else if (line === "**분석 상세**" || line.startsWith("**해석 범위:")) {
      technical = true;
      details.push(line);
    } else if (technical) {
      details.push(line);
    } else if (section) {
      const feature = line.match(/^- (AI|사람) 방향 ([+-][\d.]+) · (.*) \(특징 \d+\)$/);
      if (feature) {
        evidence = { direction: feature[1] === "AI" ? "ai" : "human", contribution: feature[2]!, description: feature[3]!, excerpts: "", verification: "", verifiedExcerpts: "" };
        section.evidence.push(evidence);
      } else if ((line.startsWith("본문 확인:") || line.startsWith("수정 검토:")) && evidence) {
        evidence.verification += line + "\n\n";
      } else if (line.startsWith("확인 원문:") && evidence) {
        evidence.verifiedExcerpts += "> " + line.slice("확인 원문:".length).trim() + "\n\n";
      } else if (line.startsWith(">") && evidence) {
        evidence.excerpts += `${line}\n\n`;
      } else if (line.startsWith("기준 ")) section.comparison = line;
      else if (line.startsWith("분석 본문 위치") || line.startsWith("기여도 합계")) details.push(`구간 ${section.number}: ${line}`);
    }
  }
  const scoreThreshold = text.match(/기준 ([\d.]+)점/)?.[1];
  const logitThreshold = text.match(/logit(?:이 | > )([\d.+-]+)/)?.[1];
  const threshold = scoreThreshold ? Number(scoreThreshold) : logitThreshold ? 100 / (1 + Math.exp(-Number(logitThreshold))) : NaN;
  if (!sections.length || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) return null;
  for (const line of details) {
    const match = line.match(/^구간 (\d+): .*? · (\d+)토큰/);
    if (match) {
      const target = sections.find(section => section.number === Number(match[1]));
      if (target) target.tokens = Number(match[2]);
    }
  }
  const completedAt = text.match(/^분석 완료: (.+)$/m)?.[1];
  return {
    scope: lines[0]!.replace(/^\*\*DetectorScope · |\*\*$/g, ""),
    threshold,
    bracketExclusion: text.includes("안의 내용은 점수와 강조 표시에서 제외했습니다"),
    sections,
    details: details.join("\n\n"),
    completedAt: completedAt && Number.isFinite(Date.parse(completedAt)) ? completedAt : undefined,
  };
}
