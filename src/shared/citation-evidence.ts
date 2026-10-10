/** Persisted with the assistant message so results survive reopening a chat. */
export const CITATION_RESULT_MARKER = "[ScholarPen Citation Results v1]\n";
export const MAX_CITATION_CLAIMS = 3;
export const MAX_CITATION_CLAIM_LENGTH = 590;

export interface EvidencePaper {
  id: string | null;
  title: string;
  doi: string | null;
  pmid: string | null;
  authors: string[];
  authorsTruncated: boolean;
  year: number | null;
  journal: string | null;
  source: string | null;
  design: string | null;
  retracted: boolean;
  expressionOfConcern: boolean;
}

export interface CitationEvidence {
  claimIndex: number;
  side: "supports" | "refutes";
  evidence: string;
  context: string | null;
  section: string | null;
  confidence: number;
  weight: number;
  paper: EvidencePaper;
}

export interface CitationFallback {
  title: string;
  doi: string;
  authors: string[];
  year: number;
  sourceDatabase: string;
  abstract?: string;
}

export interface CitationSearchResult {
  version: 1;
  selectedText: string;
  claims: string[];
  notices: string[];
  evidence: CitationEvidence[];
  fallback: CitationFallback[];
}

export function validateCitationClaims(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CITATION_CLAIMS) {
    throw new Error("검색 주장은 1–3개로 입력해 주세요.");
  }
  const claims = value.map((claim: unknown) => {
    if (typeof claim !== "string") throw new Error("검색 주장 형식이 올바르지 않습니다.");
    const text = claim.replace(/\s+/g, " ").trim();
    if (text.length < 3 || Array.from(text).length > MAX_CITATION_CLAIM_LENGTH) {
      throw new Error("각 검색 주장은 3–590자여야 합니다. 주장을 잘라내지 말고 짧은 문장으로 정리해 주세요.");
    }
    if (!/[a-z]{3}/i.test(text) || /[\u3131-\u318E\uAC00-\uD7A3]/u.test(text)) {
      throw new Error("검색 주장을 영어 문장으로 입력해 주세요.");
    }
    return text;
  });
  return [...new Set(claims)];
}

export function evidencePaperKey(paper: EvidencePaper): string {
  return paper.doi?.toLowerCase() || paper.pmid || paper.id || paper.title.toLowerCase();
}

export function evidencePaperUrl(paper: EvidencePaper): string | null {
  if (paper.doi) return `https://doi.org/${encodeURI(paper.doi).replace(/[()]/g, encodeURIComponent)}`;
  if (paper.pmid && /^\d+$/.test(paper.pmid)) return `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`;
  if (paper.id && /^PMC\d+$/i.test(paper.id)) return `https://pmc.ncbi.nlm.nih.gov/articles/${paper.id}/`;
  return null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}
function nullableText(value: unknown): boolean { return value === null || typeof value === "string"; }

/** Validate saved text before rendering it as an interactive result. */
export function parseCitationSearchResult(text: string): CitationSearchResult | null {
  const index = text.indexOf(CITATION_RESULT_MARKER);
  if (index < 0) return null;
  try {
    const value: unknown = JSON.parse(text.slice(index + CITATION_RESULT_MARKER.length));
    if (!record(value) || value.version !== 1 || typeof value.selectedText !== "string" ||
      !strings(value.claims) || !strings(value.notices) || !Array.isArray(value.evidence) || !Array.isArray(value.fallback)) return null;
    for (const item of value.evidence) {
      if (!record(item) || !record(item.paper)) return null;
      const paper = item.paper;
      if (!Number.isInteger(item.claimIndex) || typeof item.claimIndex !== "number" || item.claimIndex < 0 || item.claimIndex >= value.claims.length ||
        !["supports", "refutes"].includes(String(item.side)) || typeof item.evidence !== "string" ||
        !nullableText(item.context) || !nullableText(item.section) || typeof item.confidence !== "number" ||
        item.confidence < 0 || item.confidence > 1 || typeof item.weight !== "number" ||
        typeof paper.title !== "string" || !strings(paper.authors) || typeof paper.authorsTruncated !== "boolean" ||
        typeof paper.retracted !== "boolean" || typeof paper.expressionOfConcern !== "boolean" ||
        !(paper.year === null || typeof paper.year === "number") ||
        ![paper.id, paper.doi, paper.pmid, paper.journal, paper.source, paper.design].every(nullableText)) return null;
    }
    for (const item of value.fallback) {
      if (!record(item) || typeof item.title !== "string" || typeof item.doi !== "string" ||
        !strings(item.authors) || typeof item.year !== "number" || typeof item.sourceDatabase !== "string" ||
        !(item.abstract === undefined || typeof item.abstract === "string")) return null;
    }
    return value as unknown as CitationSearchResult; // The persisted shape was checked above.
  } catch { return null; }
}

export function serializeCitationSearchResult(result: CitationSearchResult): string {
  return `\n\n${CITATION_RESULT_MARKER}${JSON.stringify(result)}`;
}

export function citationResultText(result: CitationSearchResult): string {
  return [
    "Find Citation", ...result.notices,
    ...result.claims.map((claim, i) => `검색 주장 ${i + 1}: ${claim}`),
    ...result.evidence.map(item => [
      `${item.side === "supports" ? "지지" : "반박"} · 주장 ${item.claimIndex + 1} · ${item.paper.title}`,
      item.paper.retracted ? "철회된 논문" : "",
      item.evidence, evidencePaperUrl(item.paper) || "",
    ].filter(Boolean).join("\n")),
    ...result.fallback.map(item => `보완 후보 (근거 미판정): ${item.title}\nhttps://doi.org/${item.doi}`),
  ].join("\n\n");
}
