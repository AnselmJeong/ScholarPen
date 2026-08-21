import React, { useMemo } from "react";
import { CheckCircle2, CircleHelp, ShieldAlert } from "lucide-react";
import type {
  BibliographyEntryValidation,
  BibliographyMaintenanceResult,
} from "../../../shared/rpc-types";

const FIELD_LABELS: Record<string, string> = {
  title: "제목",
  author: "저자",
  year: "연도",
  journal: "저널",
  volume: "권",
  number: "호",
  pages: "페이지",
  doi: "DOI",
};

function statusPresentation(validation: BibliographyEntryValidation): {
  label: string;
  className: string;
} {
  switch (validation.status) {
    case "valid":
      return { label: "일치", className: "text-emerald-500" };
    case "changes":
      return validation.suggestedFields
        ? { label: "보정 완료", className: "text-emerald-500" }
        : { label: "수동 확인 필요", className: "text-amber-500" };
    case "unsupported":
      return { label: "수동 확인", className: "text-muted-foreground" };
    case "error":
      return { label: "조회 오류", className: "text-red-400" };
    default:
      return { label: "확인 불가", className: "text-muted-foreground" };
  }
}

function abbreviationSource(validation: BibliographyEntryValidation): string | null {
  const abbreviation = validation.journalAbbreviation;
  if (!abbreviation) return null;
  if (abbreviation.source === "nlm-iso") return "NLM ISO 표준 약어";
  if (abbreviation.source === "nlm-title") return "NLM 표준 약어";
  return "Crossref 출판사 제공 약어 (표준 여부 미확인)";
}

export function BibliographyValidationReview({ result }: {
  result: BibliographyMaintenanceResult;
}) {
  const summary = useMemo(() => ({
    valid: result.validations.filter((item) => item.status === "valid").length,
    applied: result.validations.filter((item) => item.suggestedFields).length,
    changes: result.validations.filter(
      (item) => item.status === "changes" && !item.suggestedFields,
    ).length,
    unverified: result.validations.filter(
      (item) => item.status === "unverified" || item.status === "error" || item.status === "unsupported",
    ).length,
  }), [result.validations]);

  return (
    <section className="rounded-md border border-border p-3">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            <h3 className="text-sm font-semibold text-foreground">인용 정리 · 서지정보 검증 완료</h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {result.scannedDocuments}개 문서 · 인용된 {result.usedEntries}개 entry · 미사용 {result.removedUnused}개 제거
          </p>
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            <span className="text-emerald-500">{summary.valid}개 일치</span>
            <span className="text-emerald-500">{summary.applied}개 확인된 보정 반영</span>
            <span className="text-amber-500">{summary.changes}개 수동 확인 필요</span>
            <span className="text-muted-foreground">{summary.unverified}개 확인 불가/수동 확인</span>
          </div>
        </div>
      </div>

      <div className="max-h-[32rem] space-y-2 overflow-y-auto pr-1">
        {result.missingCitekeys.length > 0 && (
          <div className="rounded border border-red-400/40 bg-red-500/5 px-2.5 py-2 text-xs text-red-400">
            <div className="flex items-center gap-1.5 font-medium">
              <ShieldAlert className="h-3.5 w-3.5" />
              문서에서 사용되지만 references.bib에 없는 citekey {result.missingCitekeys.length}개
            </div>
            <div className="mt-1 break-words font-mono">{result.missingCitekeys.join(", ")}</div>
          </div>
        )}
        {result.validations.map((validation) => {
          const status = statusPresentation(validation);
          const issues = validation.fields.filter(
            (field) => field.status === "missing" || field.status === "mismatch",
          );
          const source = abbreviationSource(validation);
          return (
            <div key={validation.citekey} className="rounded border border-border/70 px-2.5 py-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono text-foreground">{validation.citekey}</span>
                <span className={status.className}>{status.label}</span>
                {validation.matchMethod && (
                  <span className="text-muted-foreground">
                    {validation.matchMethod === "doi" ? "DOI 직접 조회" : `서지 일치 ${Math.round((validation.confidence ?? 0) * 100)}%`}
                  </span>
                )}
              </div>
              {validation.doi && <div className="mt-1 text-muted-foreground">DOI {validation.doi}</div>}
              {issues.map((field) => (
                <div key={field.field} className="mt-1 grid grid-cols-[64px_minmax(0,1fr)] gap-2">
                  <span className="text-amber-500">{FIELD_LABELS[field.field]}</span>
                  <span className="break-words text-muted-foreground">
                    {field.current || "(없음)"} → <span className="text-foreground">{field.canonical || "(Crossref 값 없음)"}</span>
                  </span>
                </div>
              ))}
              {validation.journalAbbreviation && source && (
                <div className="mt-1 flex items-start gap-1.5 text-muted-foreground">
                  {validation.journalAbbreviation.verified
                    ? <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
                    : <CircleHelp className="mt-0.5 h-3 w-3 shrink-0" />}
                  <span>
                    저널 약어: <span className="text-foreground">{validation.journalAbbreviation.value}</span> · {source}
                  </span>
                </div>
              )}
              {validation.message && (
                <div className="mt-1 flex items-start gap-1.5 text-red-400">
                  <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{validation.message}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
