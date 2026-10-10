import type { CitationEvidence, EvidencePaper } from "../../shared/citation-evidence";
import { validateCitationClaims } from "../../shared/citation-evidence";

const ENDPOINT = "https://paperclip.gxl.ai/api/v1/claims/support";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseEvidence(value: unknown, side: CitationEvidence["side"], claimIndex: number): CitationEvidence | null {
  if (!record(value) || !record(value.paper)) return null;
  const source = value.paper;
  const title = text(source.title);
  const evidence = text(value.evidence);
  const confidence = number(value.confidence);
  if (!title || !evidence || confidence === null || confidence < 0.8 || confidence > 1) return null;
  // Missing credibility flags must not be interpreted as a clean record.
  if (typeof source.retracted !== "boolean" || typeof source.expression_of_concern !== "boolean") return null;
  const rawDOI = text(source.doi)?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
  const paper: EvidencePaper = {
    id: text(source.id), title,
    doi: rawDOI && /^10\.\d{4,9}\/\S+$/i.test(rawDOI) ? rawDOI : null,
    pmid: text(source.pmid),
    authors: Array.isArray(source.authors) ? source.authors.filter((author): author is string => typeof author === "string") : [],
    authorsTruncated: source.authors_truncated === true,
    year: number(source.year), journal: text(source.journal), source: text(source.source),
    design: text(source.design), retracted: source.retracted,
    expressionOfConcern: source.expression_of_concern,
  };
  return {
    claimIndex, side, evidence, context: text(value.context), section: text(value.section),
    confidence, weight: number(value.weight) ?? confidence, paper,
  };
}

export async function searchPaperclipEvidence(
  claim: string,
  apiKey: string,
  claimIndex: number,
  options: { signal?: AbortSignal; fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<CitationEvidence[]> {
  validateCitationClaims([claim]);
  if (!apiKey.trim()) throw new Error("Settings → Citations에서 Paperclip API 키를 입력해 주세요.");
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 25_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (options.fetchFn ?? fetch)(ENDPOINT, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ claim, mode: "claim", min_conf: 0.8, top_n: 100, limit: 20, hybrid: true, include_context: true }),
      signal,
    });
    if (!response.ok) {
      // Never forward service error bodies (which can echo requests or secrets).
      if (response.status === 401 || response.status === 403) throw new Error("Paperclip API 키를 확인해 주세요 (Settings → Citations).");
      if (response.status === 429) throw new Error("Paperclip 이용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.");
      throw new Error(`Paperclip 검색 오류 (HTTP ${response.status}).`);
    }
    const body: unknown = await response.json();
    signal.throwIfAborted();
    if (!record(body) || !Array.isArray(body.supports) || !Array.isArray(body.refutes)) {
      throw new Error("Paperclip 응답 형식이 올바르지 않습니다.");
    }
    return (["supports", "refutes"] as const).flatMap(side => {
      const items = body[side] as unknown[];
      return items.slice(0, 20).flatMap(item => {
        const parsed = parseEvidence(item, side, claimIndex);
        return parsed ? [parsed] : [];
      });
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (timeout.aborted) throw new Error("Paperclip 검색 응답 시간이 초과되었습니다.");
    if (error instanceof SyntaxError) throw new Error("Paperclip 응답을 읽을 수 없습니다.");
    if (error instanceof TypeError) throw new Error("Paperclip에 연결할 수 없습니다.");
    throw error;
  }
}
