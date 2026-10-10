import type { AgentStreamParams, AppSettings } from "../../shared/rpc-types";
import { evidencePaperKey, type CitationSearchResult } from "../../shared/citation-evidence";
import { citationClient } from "../citation/client";
import { searchPaperclipEvidence } from "../citation/paperclip";
import { createCitationClaims } from "./citation-claims";

export async function findCitationEvidence(
  params: AgentStreamParams,
  settings: AppSettings,
  signal?: AbortSignal,
  dependencies = { createClaims: createCitationClaims, searchEvidence: searchPaperclipEvidence, searchFallback: citationClient.findSupportingCitations.bind(citationClient) },
): Promise<CitationSearchResult> {
  signal?.throwIfAborted();
  const claims = await dependencies.createClaims(params, settings, signal);
  signal?.throwIfAborted();
  const result: CitationSearchResult = {
    version: 1, selectedText: params.citationContext!.selectedText,
    claims, notices: [], evidence: [], fallback: [],
  };
  const key = settings.paperclipApiKey?.trim();
  const fallbackClaims: string[] = [];
  if (key) {
    const attempts = await Promise.allSettled(claims.map((claim, index) =>
      dependencies.searchEvidence(claim, key, index, { signal }),
    ));
    signal?.throwIfAborted();
    attempts.forEach((attempt, index) => {
      if (attempt.status === "fulfilled") {
        result.evidence.push(...attempt.value);
        const papers = new Set(attempt.value.filter(item => !item.paper.retracted).map(item => evidencePaperKey(item.paper)));
        if (papers.size < 2) fallbackClaims.push(claims[index]);
      } else {
        result.notices.push(`주장 ${index + 1}: ${attempt.reason instanceof Error ? attempt.reason.message : "Paperclip 검색에 실패했습니다."}`);
        fallbackClaims.push(claims[index]);
      }
    });
  } else {
    result.notices.push("Paperclip API 키가 없어 기존 문헌 검색을 사용했습니다. Settings → Citations에서 키를 추가할 수 있습니다.");
    fallbackClaims.push(...claims);
  }
  if (fallbackClaims.length) {
    if (key) result.notices.push("근거가 부족하거나 검색하지 못한 주장은 OpenAlex·Crossref 후보로 보완했습니다. 보완 후보는 지지·반박이 판정되지 않았습니다.");
    const timeout = AbortSignal.timeout(20_000);
    const fallbackSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const attempts = await Promise.allSettled(fallbackClaims.map(claim =>
      dependencies.searchFallback(claim, 5, settings.openAlexApiKey || undefined, fallbackSignal),
    ));
    signal?.throwIfAborted();
    const known = new Set(result.evidence.map(item => item.paper.doi?.toLowerCase()).filter(Boolean));
    for (const attempt of attempts) {
      if (attempt.status === "rejected") continue;
      for (const candidate of attempt.value) {
        if (known.has(candidate.doi.toLowerCase())) continue;
        known.add(candidate.doi.toLowerCase());
        result.fallback.push(candidate);
      }
    }
    result.fallback = result.fallback.slice(0, 8);
    if (!result.fallback.length) result.notices.push("추가 문헌 후보를 확보하지 못했습니다. 결과가 없다는 것이 해당 주장을 반박한다는 뜻은 아닙니다.");
  }
  // Group duplicate passages, retaining different judgments and claim associations.
  const seen = new Set<string>();
  result.evidence = result.evidence.filter(item => {
    const identity = `${item.claimIndex}:${item.side}:${evidencePaperKey(item.paper)}:${item.evidence}`;
    if (seen.has(identity)) return false;
    seen.add(identity); return true;
  }).sort((a, b) => Number(a.paper.retracted) - Number(b.paper.retracted) || b.weight - a.weight);
  return result;
}
