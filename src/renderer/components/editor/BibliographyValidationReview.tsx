import React, { useMemo, useState } from "react";
import { CheckCircle2, CircleHelp, Download, ShieldAlert } from "lucide-react";
import type {
  BibliographyEntryValidation,
  BibliographyMaintenanceResult,
} from "../../../shared/rpc-types";
import { buildIntegrityReportCsv, summarizeIntegrity } from "../../../shared/citation-integrity";

export const INTEGRITY_REPORT_FILENAME = "reference-integrity-report.csv";

function isRetracted(validation: BibliographyEntryValidation): boolean {
  return validation.integrityNotices?.some((notice) => notice.kind === "retracted") ?? false;
}

function IntegrityNotices({ validation }: { validation: BibliographyEntryValidation }) {
  const notice = validation.integrityNotices?.[0];
  if (!notice) return null;
  const retracted = notice.kind === "retracted";
  return (
    <div className={`mt-1 flex items-start gap-1.5 ${retracted ? "text-red-400" : "text-amber-500"}`}>
      <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
      <span>
        {retracted ? "철회된 논문입니다. 인용을 유지할지 확인하세요." : "학술지가 우려 표명(Expression of Concern)을 냈습니다."}
        {notice.date && <span className="text-muted-foreground"> · {notice.date}</span>}
        {notice.noticeDoi && (
          <>
            {" · "}
            <a className="underline" href={`https://doi.org/${notice.noticeDoi}`} target="_blank" rel="noreferrer">
              공지 {notice.noticeDoi}
            </a>
          </>
        )}
      </span>
    </div>
  );
}

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
  if (isRetracted(validation)) return { label: "철회됨", className: "font-medium text-red-400" };
  if (validation.isEditorialNotice) return { label: "공지 DOI", className: "font-medium text-red-400" };
  if (validation.integrityNotices?.length) return { label: "우려 표명", className: "font-medium text-amber-500" };
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

export function BibliographyValidationReview({ result, onExportReport }: {
  result: BibliographyMaintenanceResult;
  /** Writes the CSV report and resolves to the saved path. */
  onExportReport?: (filename: string, csv: string) => Promise<string>;
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
  const integrity = useMemo(() => summarizeIntegrity(result), [result]);
  const validations = useMemo(
    () => [...result.validations].sort((left, right) =>
      Number(isRetracted(right)) - Number(isRetracted(left))
      || Number(Boolean(right.integrityNotices?.length || right.isEditorialNotice))
        - Number(Boolean(left.integrityNotices?.length || left.isEditorialNotice))),
    [result.validations],
  );
  const vague = result.vagueAttributions ?? [];
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const exportReport = async () => {
    if (!onExportReport) return;
    setExporting(true);
    setExportMessage(null);
    try {
      const path = await onExportReport(INTEGRITY_REPORT_FILENAME, buildIntegrityReportCsv(result));
      setExportMessage({ ok: true, text: `저장됨: ${path}` });
    } catch (error) {
      setExportMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setExporting(false);
    }
  };

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
          {(integrity.retracted > 0 || integrity.concern > 0 || integrity.vague > 0) && (
            <div className="mt-1 flex flex-wrap gap-3 text-xs" data-testid="integrity-summary">
              {integrity.retracted > 0 && <span className="text-red-400">철회 {integrity.retracted}개</span>}
              {integrity.concern > 0 && <span className="text-amber-500">우려 표명 {integrity.concern}개</span>}
              {integrity.vague > 0 && <span className="text-amber-500">출처 불명확 서술 {integrity.vague}건</span>}
            </div>
          )}
        </div>
        {onExportReport && (
          <button
            type="button"
            onClick={exportReport}
            disabled={exporting}
            className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            {exporting ? "내보내는 중…" : "리포트 내보내기 (CSV)"}
          </button>
        )}
      </div>
      {exportMessage && (
        <p className={`mb-2 break-all text-xs ${exportMessage.ok ? "text-muted-foreground" : "text-red-400"}`}>
          {exportMessage.text}
        </p>
      )}

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
        {vague.length > 0 && (
          <details className="rounded border border-amber-400/40 bg-amber-500/5 px-2.5 py-2 text-xs">
            <summary className="cursor-pointer font-medium text-amber-500">
              출처가 불명확한 서술 {vague.length}건 · 인용을 붙이거나 표현을 구체화하세요
            </summary>
            <ul className="mt-2 space-y-1.5">
              {vague.map((item, index) => {
                const at = item.excerpt.indexOf(item.phrase);
                return (
                  <li key={`${item.filename}-${index}`} className="text-muted-foreground">
                    <span className="font-mono text-[11px]">{item.filename}</span>
                    <div className="text-foreground">
                      {at < 0 ? item.excerpt : (
                        <>
                          {item.excerpt.slice(0, at)}
                          <mark className="rounded bg-amber-400/30 px-0.5 text-foreground">{item.phrase}</mark>
                          {item.excerpt.slice(at + item.phrase.length)}
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </details>
        )}
        {validations.map((validation) => {
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
              <IntegrityNotices validation={validation} />
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
