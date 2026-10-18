/** Persisted with the assistant message so results survive reopening a chat. */
export const CITATION_CHECK_MARKER = "[ScholarPen Citation Check v1]\n";
/** More citations than this in one selection are reported, not checked. */
export const MAX_CHECKED_CITATIONS = 12;

export type CitationCheckVerdict =
  | "supported" | "partial" | "overclaim" | "contradicted" | "unsupported" | "unverifiable";
export type CitationCheckIssue =
  | "overgeneralization" | "causal-language" | "population" | "certainty"
  | "secondary-source" | "wrong-detail" | "off-topic" | "other";
/** What the judgment rests on: passages of the original PDF, its OpenAlex abstract, or nothing. */
export type CitationSourceBasis = "fulltext" | "abstract" | "none";

export const CITATION_CHECK_VERDICTS: readonly CitationCheckVerdict[] =
  ["supported", "partial", "overclaim", "contradicted", "unsupported", "unverifiable"];
export const CITATION_CHECK_ISSUES: readonly CitationCheckIssue[] =
  ["overgeneralization", "causal-language", "population", "certainty", "secondary-source", "wrong-detail", "off-topic", "other"];

export interface CitationCheckQuote {
  text: string;
  /** PDF page of the quoted passage; null for an abstract. */
  page: number | null;
}

export interface CitationCheckFinding {
  citekey: string;
  /** The manuscript sentence with its citation markers removed. */
  sentence: string;
  coCited: string[];
  title: string | null;
  authors: string | null;
  year: string | null;
  doi: string | null;
  basis: CitationSourceBasis;
  pdfRelpath: string | null;
  verdict: CitationCheckVerdict;
  issue: CitationCheckIssue | null;
  reason: string;
  quotes: CitationCheckQuote[];
  suggestion: string | null;
  retracted: boolean;
}

export interface CitationCheckResult {
  version: 1;
  requestId: string;
  selectedText: string;
  findings: CitationCheckFinding[];
  notices: string[];
  /** Protected rewrite applying the suggestions; staged as a tracked change on request. */
  revision: string | null;
}

export interface CitationInstance {
  citekey: string;
  /** Sentence without citation markers, for display. */
  sentence: string;
  /** Sentence for the judge: [★] marks this citation, [other citation] the rest. */
  markedSentence: string;
  /** The sentence before, to resolve references such as "this effect". */
  context: string;
  coCited: string[];
}

const GROUP = /\[@[^\]\n]+\](?:[ \t,;]*\[@[^\]\n]+\])*/g;
const KEY = /(?:^|[[;,\s])@([^\s;,\]]+)/g;
// Period-final abbreviations that do not end a sentence.
const ABBREVIATION = /(?:\bet al|\be\.g|\bi\.e|\bvs|\bcf|\bfig|\bfigs|\beq|\bno|\bvol|\bpp?|\bca|\bapprox|\bDr|\bProf|\bSt|\b[A-Z])\.$/i;

function citekeysOf(group: string): string[] {
  return [...group.matchAll(KEY)].map(match => match[1]).filter(Boolean);
}

/** Sentence-final positions (just past the terminator) in text whose citations are blanked out. */
function sentenceEnds(masked: string): number[] {
  const ends: number[] = [];
  for (const match of masked.matchAll(/[.!?。]["'”’)\]]*(?=\s|$)|\n+/g)) {
    const end = match.index! + match[0].length;
    if (match[0][0] === "." && ABBREVIATION.test(masked.slice(Math.max(0, match.index! - 8), match.index! + 1))) continue;
    ends.push(end);
  }
  if (!ends.length || ends.at(-1)! < masked.length) ends.push(masked.length);
  return ends;
}

function clean(text: string): string {
  return text.replace(GROUP, " ").replace(/\s+/g, " ").replace(/\s+([.,;:!?。])/g, "$1").trim();
}

/**
 * Pairs every citation in a passage (citations shown as `[@key]`, `[@a; @b]` or
 * adjacent groups) with the sentence it supports. A citation placed right after a
 * sentence's full stop belongs to that sentence, as authors often write
 * "… was observed. [@key] Next sentence".
 */
export function extractCitationInstances(text: string): CitationInstance[] {
  const groups = [...text.matchAll(GROUP)].map(match => ({
    start: match.index!, end: match.index! + match[0].length, keys: citekeysOf(match[0]),
  })).filter(group => group.keys.length);
  if (!groups.length) return [];
  let masked = text;
  for (const group of groups) masked = masked.slice(0, group.start) + " ".repeat(group.end - group.start) + masked.slice(group.end);
  const ends = sentenceEnds(masked);
  const spans = ends.map((end, index) => ({ from: index > 0 ? ends[index - 1] : 0, to: end }));
  const sentenceOf = (group: { start: number; end: number }) => {
    let index = ends.findIndex(end => end > group.start);
    if (index < 0) index = ends.length - 1;
    // Only whitespace between the last full stop and the citation: it closes that sentence.
    if (index > 0 && !masked.slice(spans[index].from, group.start).trim()) {
      index -= 1;
      while (index > 0 && !masked.slice(spans[index].from, spans[index].to).trim()) index -= 1;
    }
    return index;
  };
  const assigned = groups.map(group => ({ ...group, sentence: sentenceOf(group) }));
  const instances: CitationInstance[] = [];
  const seen = new Set<string>();
  for (const group of assigned) {
    const span = spans[group.sentence];
    // A citation after the full stop sits outside the sentence span; extend over it.
    const sameSentence = assigned.filter(other => other.sentence === group.sentence);
    const to = Math.max(span.to, ...sameSentence.map(other => other.end));
    const raw = text.slice(span.from, to);
    const sentence = clean(raw);
    if (!sentence.replace(/[\p{P}\s]/gu, "")) continue;
    const previous = group.sentence > 0 ? clean(text.slice(spans[group.sentence - 1].from, spans[group.sentence - 1].to)) : "";
    for (const citekey of group.keys) {
      const identity = `${citekey}\u0000${sentence}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      let marked = "";
      let cursor = span.from;
      // The previous sentence's trailing citation can sit inside this span: drop it.
      for (const other of assigned.filter(item => item.start >= span.from && item.end <= to)) {
        marked += text.slice(cursor, other.start);
        const others = other.keys.filter(key => key !== citekey).length;
        if (other.sentence === group.sentence) {
          marked += other === group ? (others ? `[★ + ${others} other citation${others > 1 ? "s" : ""}]` : "[★]") : "[other citation]";
        }
        cursor = other.end;
      }
      marked += text.slice(cursor, to);
      instances.push({
        citekey,
        sentence,
        markedSentence: marked.replace(/\s+/g, " ").trim(),
        context: previous,
        coCited: [...new Set(sameSentence.flatMap(other => other.keys))].filter(key => key !== citekey),
      });
    }
  }
  return instances;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function nullableString(value: unknown): boolean { return value === null || typeof value === "string"; }
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

export function serializeCitationCheckResult(result: CitationCheckResult): string {
  return `\n\n${CITATION_CHECK_MARKER}${JSON.stringify(result)}`;
}

/** Validate saved text before rendering it as an interactive result. */
export function parseCitationCheckResult(text: string): CitationCheckResult | null {
  const index = text.indexOf(CITATION_CHECK_MARKER);
  if (index < 0) return null;
  try {
    const value: unknown = JSON.parse(text.slice(index + CITATION_CHECK_MARKER.length));
    if (!record(value) || value.version !== 1 || typeof value.requestId !== "string" || typeof value.selectedText !== "string" ||
      !strings(value.notices) || !Array.isArray(value.findings) || !nullableString(value.revision)) return null;
    for (const item of value.findings) {
      if (!record(item) || typeof item.citekey !== "string" || typeof item.sentence !== "string" || !strings(item.coCited) ||
        ![item.title, item.authors, item.year, item.doi, item.pdfRelpath, item.suggestion].every(nullableString) ||
        !["fulltext", "abstract", "none"].includes(String(item.basis)) ||
        !CITATION_CHECK_VERDICTS.includes(item.verdict as CitationCheckVerdict) ||
        !(item.issue === null || CITATION_CHECK_ISSUES.includes(item.issue as CitationCheckIssue)) ||
        typeof item.reason !== "string" || typeof item.retracted !== "boolean" || !Array.isArray(item.quotes) ||
        !item.quotes.every(quote => record(quote) && typeof quote.text === "string" && (quote.page === null || typeof quote.page === "number"))) return null;
    }
    return value as unknown as CitationCheckResult; // The persisted shape was checked above.
  } catch { return null; }
}

export const VERDICT_LABELS: Record<CitationCheckVerdict, string> = {
  supported: "지지됨",
  partial: "부분 지지",
  overclaim: "과장",
  contradicted: "원문과 반대",
  unsupported: "원문에 근거 없음",
  unverifiable: "확인 불가",
};

export const ISSUE_LABELS: Record<CitationCheckIssue, string> = {
  "overgeneralization": "과잉 일반화",
  "causal-language": "연관성을 인과로 서술",
  "population": "대상·모델의 확대 적용",
  "certainty": "확실성 과장",
  "secondary-source": "2차 인용·리뷰를 1차 근거처럼 인용",
  "wrong-detail": "세부 내용 불일치",
  "off-topic": "주제와 무관한 인용",
  "other": "기타",
};

/** Abstract-only absence is weaker evidence than absence from the paper's passages. */
export function verdictLabel(finding: Pick<CitationCheckFinding, "verdict" | "basis">): string {
  if (finding.verdict === "unsupported" && finding.basis === "abstract") return "초록에서 확인 안 됨";
  return VERDICT_LABELS[finding.verdict];
}

export function isCitationProblem(finding: Pick<CitationCheckFinding, "verdict">): boolean {
  return ["partial", "overclaim", "contradicted", "unsupported"].includes(finding.verdict);
}

export function citationCheckResultText(result: CitationCheckResult): string {
  return [
    "Check Citations", ...result.notices,
    ...result.findings.map(finding => [
      `[@${finding.citekey}] ${verdictLabel(finding)} · ${finding.basis === "fulltext" ? "원문 확인" : finding.basis === "abstract" ? "초록만 확인" : "원문 없음"}`,
      `문장: ${finding.sentence}`,
      finding.issue ? `유형: ${ISSUE_LABELS[finding.issue]}` : "",
      finding.reason ? `이유: ${finding.reason}` : "",
      ...finding.quotes.map(quote => `원문${quote.page ? ` (p. ${quote.page})` : ""}: “${quote.text}”`),
      finding.suggestion ? `개선안: ${finding.suggestion}` : "",
    ].filter(Boolean).join("\n")),
  ].join("\n\n");
}
