import React from "react";
import { Check, X } from "lucide-react";
import type { ThreadSnapshot } from "../../../shared/collab/threads";
import { isAIUser } from "../../../shared/collab/personas";

/** Completion is a saved result, not a toast: it stays until acknowledged. */
export function WatermarkResultCard({ threads, onDismiss }: {
  threads: ThreadSnapshot[];
  onDismiss: (threadId: string) => void;
}) {
  const latest = threads.filter(thread => thread.meta.documentAction === "remove-watermark" &&
    (thread.resolved || thread.meta.status === "resolved"))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!latest || latest.meta.resultDismissedAt !== undefined) return null;
  const reply = [...latest.comments].reverse().find(comment => !comment.deleted && isAIUser(comment.userId));
  if (!reply) return null;
  const result = latest.meta.watermarkResult;
  const changed = result && result.removed + result.replaced > 0;
  return <section aria-label="Remove watermark result" className="border-b border-border bg-muted/30 px-3 py-2.5">
    <div className="flex items-center gap-1.5">
      <Check className="h-3.5 w-3.5 text-emerald-600" />
      <span className="flex-1 text-xs font-medium">Remove watermark · 실행 결과</span>
      <button type="button" aria-label="워터마크 정리 결과 닫기" title="결과 닫기 · 기록은 Resolved에 유지됩니다"
        onClick={() => onDismiss(latest.id)} className="rounded p-0.5 text-muted-foreground hover:bg-muted">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
    {result ? <>
      <p role="status" className="mt-1.5 text-xs leading-5">
        {changed ? `숨은 문자 ${result.removed}개 제거 · 특수 공백 ${result.replaced}개 정리`
          : result.skipped ? "검사한 텍스트에서 정리할 문자가 없었습니다. 일부 블록은 제외되었습니다."
          : "정리할 숨은 문자·특수 공백이 없었습니다. 원문을 유지했습니다."}
      </p>
      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
        {result.scanned}개 텍스트 블록 검사
        {result.skipped > 0 && ` · 코드 또는 검토 중인 수정안이 있는 ${result.skipped}개 블록 제외`}
      </p>
      <details className="mt-1 text-[11px] leading-4 text-muted-foreground">
        <summary className="cursor-pointer">상세 결과</summary>
        <p className="mt-1 whitespace-pre-wrap">{reply.text}</p>
      </details>
    </> : <p role="status" className="mt-1.5 whitespace-pre-wrap text-xs leading-5">{reply.text}</p>}
    <p className="mt-1 text-[10px] text-muted-foreground">문체 재작성 없이 숨은 유니코드 문자와 특수 공백을 정리합니다.</p>
  </section>;
}
