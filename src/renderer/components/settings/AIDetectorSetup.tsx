import React, { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { rpc } from "../../rpc";
import type { AIDetectorStatus } from "../../../shared/ai-detector-setup";

const phases = ["bootstrap", "python", "dependencies", "models", "verification"] as const;

export function AIDetectorSetup({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<AIDetectorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const actionVersion = useRef(0);
  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let installing = false;
      const version = actionVersion.current;
      try {
        const next = await rpc.getAIDetectorStatus();
        if (!stopped && version === actionVersion.current) { setStatus(next); setError(null); installing = next.state === "installing"; }
      } catch (cause) {
        if (!stopped && !compact) setError(cause instanceof Error ? cause.message : "설치 상태를 확인할 수 없습니다.");
      }
      if (!stopped) timer = setTimeout(poll, installing ? 1000 : 5000);
    };
    void poll();
    return () => { stopped = true; mounted.current = false; clearTimeout(timer); };
  }, [compact]);
  const act = useCallback(async (cancel: boolean) => {
    actionVersion.current++;
    setPending(true);
    setError(null);
    try {
      const next = await (cancel ? rpc.cancelAIDetectorInstall() : rpc.installAIDetector());
      if (mounted.current) setStatus(next);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "설치 요청에 실패했습니다.");
    } finally { if (mounted.current) setPending(false); }
  }, []);
  if (compact && (!status || status.state === "ready")) return null;
  const installing = status?.state === "installing";
  const progress = installing ? status.progress : null;
  const percentage = progress?.total ? Math.min(100, progress.completed / progress.total * 100) : undefined;
  const label = progress ? progress.kind === "files"
    ? `모델 파일 ${progress.completed}/${progress.total ?? "?"}개 (전체 용량 진행률과 다름)`
    : `${(progress.completed / 1024 ** 2).toFixed(1)}MB${progress.total ? ` / ${(progress.total / 1024 ** 2).toFixed(1)}MB` : ""}` : null;
  return (
    <section aria-label="DetectorScope installation" className={compact ? "border-b border-border bg-muted/20 p-3 text-xs" : "rounded-lg border border-border p-4 text-sm"}>
      <div className="flex items-center gap-2 font-medium"><Download size={15} /> DetectorScope · 로컬 AI 텍스트 분석</div>
      {status?.state !== "ready" && <p className="mt-2 text-xs leading-5 text-muted-foreground">최초 설치 약 12GB · 여유 공간 20GB 필요 · Apple Silicon Mac. 실행 환경과 모델을 앱에서 준비하며, 설치 후 원고는 로컬에서 분석합니다.</p>}
      <p role="status" aria-live="polite" className="mt-2 flex items-start gap-1.5 text-xs leading-5">
        {installing && <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" />}
        {installing ? `${phases.indexOf(status.phase) + 1}/5 · ` : ""}{status?.state === "error" ? "설치를 완료하지 못했습니다." : status?.detail ?? "설치 상태 확인 중…"}
      </p>
      {installing && <div className="mt-2 space-y-1">
        <progress aria-label={progress?.kind === "files" ? "모델 파일 다운로드" : "설치 다운로드"} max={100} value={percentage} className="h-2 w-full accent-primary" />
        {label && <p className="text-[11px] text-muted-foreground">{label}</p>}
        <p className="text-[11px] text-muted-foreground">이 화면을 닫아도 계속됩니다. 앱을 종료하면 설치가 중단됩니다.</p>
      </div>}
      {(error || status?.state === "error") && <p role="alert" className="mt-2 text-xs text-red-600">{error ?? (status?.state === "error" ? status.detail : "")}</p>}
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={pending || (!status && !error)} onClick={() => void act(installing)}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50">
          {pending ? "처리 중…" : installing ? "설치 취소" : status?.state === "ready" ? "설치·복구" : status?.state === "error" ? "다시 시도" : "설치·다운로드"}
        </button>
        {status?.state === "ready" && <span className="self-center text-xs text-muted-foreground">/ai-score로 분석</span>}
      </div>
    </section>
  );
}
