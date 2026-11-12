import { useExtensionEnabled } from "../../../renderer/extensions/state";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { rpc } from "../../../renderer/rpc";
import type { AIDetectorStatus } from "../../../shared/ai-detector-setup";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { SettingsError, SettingsNote, SettingsSection } from "../../../renderer/components/settings/settings-kit";

const phases = ["bootstrap", "python", "dependencies", "models", "verification"] as const;

export function AIDetectorSetup({ compact = false }: { compact?: boolean }) {
  const enabled = useExtensionEnabled("scholarpen.ai-writing-score");
  const [status, setStatus] = useState<AIDetectorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const actionVersion = useRef(0);
  useEffect(() => {
    mounted.current = true;
    if (!enabled) return;
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
  }, [compact, enabled]);
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
  if (!enabled) return null;
  if (compact && (!status || status.state === "ready")) return null;
  const installing = status?.state === "installing";
  const progress = installing ? status.progress : null;
  const percentage = progress?.total ? Math.min(100, progress.completed / progress.total * 100) : undefined;
  const label = progress ? progress.kind === "files"
    ? `모델 파일 ${progress.completed}/${progress.total ?? "?"}개 (전체 용량 진행률과 다름)`
    : `${(progress.completed / 1024 ** 2).toFixed(1)}MB${progress.total ? ` / ${(progress.total / 1024 ** 2).toFixed(1)}MB` : ""}` : null;
  const statusLine = <p role="status" aria-live="polite" className="flex items-start gap-1.5 text-xs leading-5">
    {installing && <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" />}
    {installing ? `${phases.indexOf(status.phase) + 1}/5 · ` : ""}{status?.state === "error" ? "설치를 완료하지 못했습니다." : status?.detail ?? "설치 상태 확인 중…"}
  </p>;
  const progressBlock = installing && <VStack gap={1}>
    <progress aria-label={progress?.kind === "files" ? "모델 파일 다운로드" : "설치 다운로드"} max={100} value={percentage} className="h-1.5 w-full accent-primary" />
    {label && <Text type="supporting" display="block" hasTabularNumbers>{label}</Text>}
    <SettingsNote>이 화면을 닫아도 계속됩니다. 앱을 종료하면 설치가 중단됩니다.</SettingsNote>
  </VStack>;
  const failure = (error || status?.state === "error") && <SettingsError>{error ?? (status?.state === "error" ? status.detail : "")}</SettingsError>;
  const actions = <HStack gap={2} vAlign="center">
    <Button size="sm" variant={installing || status?.state === "ready" ? "secondary" : "primary"} isDisabled={pending || (!status && !error)} onClick={() => void act(installing)}
      label={pending ? "처리 중…" : installing ? "설치 취소" : status?.state === "ready" ? "설치·복구" : status?.state === "error" ? "다시 시도" : "설치·다운로드"} />
    {status?.state === "ready" && <Text type="supporting">/ai-score로 분석</Text>}
  </HStack>;
  if (compact) return (
    <section aria-label="DetectorScope installation" className="border-b border-border bg-muted/20 p-3 text-xs">
      <VStack gap={2}>
        <div className="flex items-center gap-2 font-medium"><Download size={15} aria-hidden="true" /> DetectorScope · 로컬 AI 텍스트 분석</div>
        {status?.state !== "ready" && <SettingsNote>최초 설치 약 12GB · 여유 공간 20GB 필요 · Apple Silicon Mac. 실행 환경과 모델을 앱에서 준비하며, 설치 후 원고는 로컬에서 분석합니다.</SettingsNote>}
        {statusLine}{progressBlock}{failure}{actions}
      </VStack>
    </section>
  );
  return (
    <SettingsSection title="DetectorScope · 로컬 AI 텍스트 분석" label="DetectorScope installation"
      description={status?.state !== "ready" ? "최초 설치 약 12GB · 여유 공간 20GB 필요 · Apple Silicon Mac. 실행 환경과 모델을 앱에서 준비하며, 설치 후 원고는 로컬에서 분석합니다." : undefined}>
      <VStack gap={2}>{statusLine}{progressBlock}{failure}{actions}</VStack>
    </SettingsSection>
  );
}
