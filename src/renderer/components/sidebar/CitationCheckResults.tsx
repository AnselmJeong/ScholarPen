import React, { useState } from "react";
import {
  ISSUE_LABELS, isCitationProblem, verdictLabel,
  type CitationCheckFinding, type CitationCheckResult, type CitationCheckVerdict,
} from "@shared/citation-check";
import type { ProjectFileReference } from "@shared/project-file-reference";
import { cn } from "@/lib/utils";

const ORDER: CitationCheckVerdict[] = ["contradicted", "overclaim", "partial", "unsupported", "unverifiable", "supported"];

function verdictTone(finding: CitationCheckFinding): string {
  if (finding.verdict === "supported") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (finding.verdict === "unverifiable") return "bg-muted text-muted-foreground";
  if (finding.verdict === "unsupported" && finding.basis === "abstract") return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "bg-destructive/10 text-destructive";
}

function BasisBadge({ finding }: { finding: CitationCheckFinding }) {
  if (finding.basis === "fulltext") {
    return <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary" title="resources/의 원문 PDF에서 관련 단락을 찾아 판단했습니다.">원문 PDF 확인</span>;
  }
  if (finding.basis === "abstract") {
    return <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-300" title="원문 PDF가 없어 OpenAlex 초록만으로 판단했습니다. 본문에만 있는 내용은 확인하지 못합니다.">초록만 확인 · 확실성 낮음</span>;
  }
  return <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">원문·초록 없음</span>;
}

function FindingCard({ finding, onOpenProjectSource }: {
  finding: CitationCheckFinding;
  onOpenProjectSource?: (reference: ProjectFileReference) => void;
}) {
  const problem = isCitationProblem(finding);
  const openPdf = (page?: number) => {
    if (finding.pdfRelpath) onOpenProjectSource?.({ relativePath: finding.pdfRelpath, page });
  };
  return <article className={cn("space-y-2 rounded-md border bg-background p-3", problem ? "border-destructive/40" : "border-border")}>
    <div className="flex flex-wrap items-center gap-1 text-[11px]">
      <span className="font-mono text-xs text-foreground">[@{finding.citekey}]</span>
      <span className={cn("rounded px-1.5 py-0.5 font-medium", verdictTone(finding))}>{verdictLabel(finding)}</span>
      <BasisBadge finding={finding} />
      {finding.issue && <span className="rounded bg-muted px-1.5 py-0.5">{ISSUE_LABELS[finding.issue]}</span>}
      {finding.retracted && <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">철회된 논문</span>}
    </div>
    {(finding.title || finding.authors) && <p className="text-xs text-muted-foreground">
      {finding.authors ?? "저자 미상"} ({finding.year ?? "n.d."}). {finding.title}
      {finding.pdfRelpath && onOpenProjectSource && <>{" · "}<button type="button" className="text-primary underline" onClick={() => openPdf()}>PDF 열기</button></>}
    </p>}
    <div className="space-y-0.5">
      <p className="text-[11px] font-medium text-muted-foreground">문장</p>
      <p className="text-xs leading-relaxed">{finding.sentence}</p>
      {finding.coCited.length > 0 && <p className="text-[11px] text-muted-foreground">함께 인용: {finding.coCited.map(key => `@${key}`).join(", ")}</p>}
    </div>
    {finding.reason && <div className="space-y-0.5">
      <p className="text-[11px] font-medium text-muted-foreground">{problem ? "오류로 본 이유" : "판단"}</p>
      <p className="text-xs leading-relaxed">{finding.reason}</p>
    </div>}
    {finding.quotes.length > 0 && <div className="space-y-1">
      <p className="text-[11px] font-medium text-muted-foreground">원문 근거 (원문에서 확인된 문장)</p>
      {finding.quotes.map((quote, index) => <blockquote key={index} className="border-l-2 border-primary/30 pl-2 text-xs leading-relaxed whitespace-pre-wrap">
        “{quote.text}”
        {quote.page !== null && finding.pdfRelpath && onOpenProjectSource
          ? <> <button type="button" className="text-[11px] text-primary underline" onClick={() => openPdf(quote.page ?? undefined)}>p. {quote.page}</button></>
          : quote.page !== null ? <span className="text-[11px] text-muted-foreground"> p. {quote.page}</span> : <span className="text-[11px] text-muted-foreground"> (초록)</span>}
      </blockquote>)}
    </div>}
    {finding.suggestion && <div className="space-y-0.5 rounded bg-muted/60 p-2">
      <p className="text-[11px] font-medium text-muted-foreground">{finding.verdict === "unsupported" ? "개선 방법" : "개선안"}</p>
      <p className="text-xs leading-relaxed">{finding.suggestion}</p>
    </div>}
  </article>;
}

export function CitationCheckResults({ result, onOpenProjectSource, onApplyRevision }: {
  result: CitationCheckResult;
  onOpenProjectSource?: (reference: ProjectFileReference) => void;
  onApplyRevision?: (requestId: string, protectedRevision: string) => string | null;
}) {
  const [applyStatus, setApplyStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const findings = [...result.findings].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict));
  const problems = findings.filter(isCitationProblem);
  const supported = findings.filter(finding => finding.verdict === "supported");
  const unverifiable = findings.filter(finding => finding.verdict === "unverifiable");
  const fulltext = result.findings.filter(finding => finding.basis === "fulltext").length;
  const abstract = result.findings.filter(finding => finding.basis === "abstract").length;
  const revision = result.revision;
  const apply = () => {
    if (!revision || !onApplyRevision) return;
    const error = onApplyRevision(result.requestId, revision);
    setApplyStatus(error
      ? { kind: "error", message: error }
      : { kind: "success", message: "개선안을 변경 추적으로 표시했습니다. 협업 편집의 Accept 또는 Reject로 결정해 주세요." });
  };
  return <div className="not-prose space-y-4 break-words" data-citation-check>
    <div>
      <h2 className="text-sm font-semibold">인용 확인</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        인용 {result.findings.length}건 · 문제 {problems.length} · 지지 {supported.length} · 확인 불가 {unverifiable.length}
        {" "}(원문 PDF {fulltext}, 초록만 {abstract}). 원문 PDF를 본 판정이 초록만 본 판정보다 확실합니다. 근거 문장은 원문에 그대로 있는 것만 표시합니다.
      </p>
    </div>
    {result.notices.length > 0 && <div role="status" className="space-y-1 rounded-md bg-muted p-2 text-xs text-muted-foreground">
      {result.notices.map((notice, index) => <p key={index}>{notice}</p>)}
    </div>}
    {revision && <div className="space-y-1 rounded-md border border-primary/30 p-2">
      <p className="text-xs">개선안을 반영한 선택 영역 수정안이 준비되어 있습니다.</p>
      {onApplyRevision
        ? <button type="button" disabled={applyStatus?.kind === "success"} onClick={apply} className="text-xs font-medium text-primary disabled:opacity-50">
          {applyStatus?.kind === "success" ? "변경 추적으로 표시됨" : "개선안을 문서에 변경 추적으로 표시"}
        </button>
        : <p className="text-xs text-muted-foreground">편집 세션이 끝나 문서에 적용할 수 없습니다. 개선안을 참고해 직접 고치거나 다시 확인해 주세요.</p>}
      {applyStatus && <p role={applyStatus.kind === "error" ? "alert" : "status"} className={cn("text-xs", applyStatus.kind === "error" ? "text-destructive" : "text-muted-foreground")}>{applyStatus.message}</p>}
    </div>}
    {problems.length > 0 && <section className="space-y-2" aria-label="문제가 있는 인용">
      <h3 className="text-sm font-semibold">확인이 필요한 인용 <span className="text-muted-foreground">{problems.length}건</span></h3>
      {problems.map((finding, index) => <FindingCard key={`p${index}`} finding={finding} onOpenProjectSource={onOpenProjectSource} />)}
    </section>}
    {unverifiable.length > 0 && <section className="space-y-2" aria-label="확인하지 못한 인용">
      <h3 className="text-sm font-semibold">확인하지 못한 인용 <span className="text-muted-foreground">{unverifiable.length}건</span></h3>
      {unverifiable.map((finding, index) => <FindingCard key={`u${index}`} finding={finding} onOpenProjectSource={onOpenProjectSource} />)}
    </section>}
    {supported.length > 0 && <details className="space-y-2" open={problems.length === 0}>
      <summary className="cursor-pointer text-sm font-semibold">지지되는 인용 <span className="text-muted-foreground">{supported.length}건</span></summary>
      <div className="mt-2 space-y-2">
        {supported.map((finding, index) => <FindingCard key={`s${index}`} finding={finding} onOpenProjectSource={onOpenProjectSource} />)}
      </div>
    </details>}
  </div>;
}
