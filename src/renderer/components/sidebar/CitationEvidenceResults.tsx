import React, { useState } from "react";
import { evidencePaperKey, evidencePaperUrl, validateCitationClaims, type CitationEvidence, type CitationSearchResult } from "@shared/citation-evidence";
import { rpc } from "../../rpc";
import { addEvidenceCitation } from "../../ai/citation-library";

const DESIGNS: Record<string, string> = {
  meta_analysis: "메타분석", systematic_review: "체계적 문헌고찰", rct: "무작위 대조시험",
  cohort: "코호트", case_control: "환자–대조군", cross_sectional: "단면연구",
  case_report: "증례", review: "문헌고찰", animal: "동물연구", in_vitro: "시험관 연구", opinion: "의견",
};

function CitationActions({ doi, title, url, projectPath, disabled = false }: {
  doi: string | null; title: string; url: string | null; projectPath: string | null; disabled?: boolean;
}) {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [citekey, setCitekey] = useState("");
  async function add() {
    if (!doi || !projectPath || busy) return;
    setBusy(true); setStatus("");
    try {
      const key = await addEvidenceCitation(projectPath, doi);
      setCitekey(key); setStatus("참고문헌에 저장됨 · 편집기에서 @로 인용할 수 있습니다.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "참고문헌 추가에 실패했습니다."); }
    finally { setBusy(false); }
  }
  return <div className="space-y-1">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {url && <button type="button" className="text-primary underline" onClick={() => rpc.openExternal(url).catch(() => setStatus("논문 링크를 열지 못했습니다."))}>논문 열기</button>}
      {doi && projectPath && <button type="button" disabled={busy || disabled || Boolean(citekey)} onClick={add} aria-label={`${title} 참고문헌에 추가`} className="text-primary disabled:opacity-50">{busy ? "서지정보 확인 중…" : citekey ? "추가됨" : "참고문헌에 추가"}</button>}
      {citekey && <button type="button" className="text-primary" onClick={() => navigator.clipboard.writeText(`[@${citekey}]`).then(() => setStatus("인용 키를 복사했습니다.")).catch(() => setStatus("복사하지 못했습니다."))}>인용 키 복사</button>}
      {!doi && <span className="text-muted-foreground">DOI 없음 · 원문 확인 필요</span>}
    </div>
    {status && <p role="status" className="text-xs text-muted-foreground">{status}</p>}
  </div>;
}

function PaperCard({ items, projectPath }: { items: CitationEvidence[]; projectPath: string | null }) {
  const paper = items[0].paper;
  const preprint = ["biorxiv", "medrxiv", "arxiv"].includes(paper.source?.toLowerCase() ?? "");
  return <article className="space-y-2 rounded-md border border-border bg-background p-3">
    <p className="text-sm font-medium leading-snug">{paper.title}</p>
    <p className="text-xs text-muted-foreground">{paper.authors.slice(0, 3).join(", ")}{paper.authorsTruncated || paper.authors.length > 3 ? " et al." : ""} · {paper.year ?? "연도 미상"}{paper.journal ? ` · ${paper.journal}` : ""}</p>
    <div className="flex flex-wrap gap-1 text-[11px]">
      <span className="rounded bg-muted px-1.5 py-0.5" title="연구 설계는 자동 분류입니다">{DESIGNS[paper.design ?? ""] ?? paper.design ?? "연구 설계 미분류"}</span>
      {paper.source && <span className="rounded bg-muted px-1.5 py-0.5">{paper.source}</span>}
      {preprint && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">프리프린트</span>}
      {paper.retracted && <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">철회된 논문 · 인용 제외</span>}
      {paper.expressionOfConcern && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">우려 표명</span>}
    </div>
    {items.map((item, index) => <div key={index} className="space-y-1 border-t border-border pt-2">
      <p className="text-[11px] text-muted-foreground">주장 {item.claimIndex + 1} · {item.section || "위치 미상"} · <span title="이 문장이 주장을 지지하거나 반박한다고 모델이 판단한 확신이며, 연구의 질이나 주장이 참일 확률은 아닙니다.">판정 확신 {Math.round(item.confidence * 100)}%</span></p>
      <blockquote className="border-l-2 border-primary/30 pl-2 text-xs leading-relaxed whitespace-pre-wrap">{item.evidence}</blockquote>
      {item.context && <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">주변 원문 보기</summary><p className="mt-1 whitespace-pre-wrap leading-relaxed">{item.context}</p></details>}
    </div>)}
    <CitationActions doi={paper.doi} title={paper.title} url={evidencePaperUrl(paper)} projectPath={projectPath} disabled={paper.retracted} />
  </article>;
}

function EvidenceGroup({ side, evidence, projectPath }: { side: CitationEvidence["side"]; evidence: CitationEvidence[]; projectPath: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const groups = new Map<string, CitationEvidence[]>();
  for (const item of evidence.filter(item => item.side === side && !item.paper.retracted)) {
    const key = evidencePaperKey(item.paper);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const papers = [...groups.entries()];
  return <section className="space-y-2" aria-label={side === "supports" ? "지지 근거" : "반박 근거"}>
    <h3 className="text-sm font-semibold">{side === "supports" ? "지지 근거" : "반박 근거"} <span className="text-muted-foreground">{papers.length}편</span></h3>
    {!papers.length && <p className="text-xs text-muted-foreground">확보한 근거가 없습니다.</p>}
    {(expanded ? papers : papers.slice(0, 5)).map(([key, items]) => <PaperCard key={key} items={items} projectPath={projectPath} />)}
    {papers.length > 5 && <button type="button" className="text-xs text-primary" onClick={() => setExpanded(!expanded)}>{expanded ? "접기" : `${papers.length - 5}편 더 보기`}</button>}
  </section>;
}

export function CitationEvidenceResults({ result, projectPath, onRetry, busy = false }: {
  result: CitationSearchResult; projectPath: string | null;
  onRetry?: (claims: string[], selectedText: string) => void; busy?: boolean;
}) {
  const [claims, setClaims] = useState(result.claims);
  const [error, setError] = useState("");
  const retracted = result.evidence.filter(item => item.paper.retracted);
  return <div className="not-prose space-y-4 break-words" data-citation-results>
    <div>
      <h2 className="text-sm font-semibold">인용 근거</h2>
      <p className="mt-1 text-xs text-muted-foreground">근거 문장의 지지·반박은 Paperclip의 자동 판정입니다. 연구의 질과 선택문에 대한 적합성은 원문에서 확인해 주세요.</p>
    </div>
    {result.notices.length > 0 && <div role="status" className="space-y-1 rounded-md bg-muted p-2 text-xs text-muted-foreground">{result.notices.map((notice, index) => <p key={index}>{notice}</p>)}</div>}
    <details className="rounded-md border border-border p-2 text-xs">
      <summary className="cursor-pointer font-medium">검색 주장 {result.claims.length}개 · 확인 및 수정</summary>
      <div className="mt-2 space-y-2">
        {claims.map((claim, index) => <label key={index} className="block space-y-1"><span>주장 {index + 1}</span><textarea aria-label={`검색 주장 ${index + 1}`} value={claim} rows={3} className="w-full resize-y rounded border border-input bg-background p-2 text-xs" onChange={event => setClaims(current => current.map((text, i) => i === index ? event.target.value : text))} /><span className="text-muted-foreground">{Array.from(claim).length}/590자</span></label>)}
        {onRetry && <button type="button" disabled={busy} className="text-primary disabled:opacity-50" onClick={() => {
          try { const validated = validateCitationClaims(claims); setError(""); onRetry(validated, result.selectedText); }
          catch (err) { setError(err instanceof Error ? err.message : "검색 주장을 확인해 주세요."); }
        }}>수정한 주장으로 재검색</button>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </div>
    </details>
    <EvidenceGroup side="supports" evidence={result.evidence} projectPath={projectPath} />
    <EvidenceGroup side="refutes" evidence={result.evidence} projectPath={projectPath} />
    {retracted.length > 0 && <details className="space-y-2"><summary className="cursor-pointer text-xs text-destructive">철회된 논문의 근거 {retracted.length}건 · 추천에서 제외</summary>{retracted.map((item, index) => <PaperCard key={index} items={[item]} projectPath={projectPath} />)}</details>}
    {result.fallback.length > 0 && <section className="space-y-2" aria-label="보완 후보">
      <h3 className="text-sm font-semibold">보완 후보 · 근거 미판정</h3>
      <p className="text-xs text-muted-foreground">OpenAlex·Crossref 검색 결과이며, 선택문을 직접 뒷받침하는지는 확인되지 않았습니다.</p>
      {result.fallback.map(item => <article key={item.doi} className="space-y-2 rounded-md border border-border p-3">
        <p className="text-sm font-medium">{item.title}</p>
        <p className="text-xs text-muted-foreground">{item.authors.slice(0, 3).join(", ")} · {item.year || "연도 미상"} · {item.sourceDatabase}</p>
        {item.abstract ? <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">초록 보기</summary><p className="mt-1 leading-relaxed">{item.abstract}</p></details> : <p className="text-xs text-muted-foreground">초록 없음 · 서지정보 수준 후보</p>}
        <CitationActions doi={item.doi} title={item.title} url={`https://doi.org/${encodeURI(item.doi)}`} projectPath={projectPath} />
      </article>)}
    </section>}
  </div>;
}
