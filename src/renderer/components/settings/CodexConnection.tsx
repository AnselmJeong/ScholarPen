import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { rpc } from "../../rpc";
import { codexQuotaError, type CodexStatus } from "@shared/codex";

export function CodexConnection({ model, onModelChange }: { model: string; onModelChange: (model: string) => void }) {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const refreshing = useRef(false);
  const stateRef = useRef<CodexStatus["state"] | null>(null);

  const refresh = useCallback(async (reloadModels = false) => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const next = await rpc.getCodexStatus();
      if (!mounted.current) return;
      setStatus(next);
      if (next.state === "connected" && (reloadModels || stateRef.current !== "connected")) {
        const available = await rpc.listProviderModels("codex");
        if (mounted.current) setModels(available);
      } else if (next.state !== "connected") setModels([]);
      stateRef.current = next.state;
      if (mounted.current) setError(null);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally { refreshing.current = false; }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => { void refresh(); }, status?.state === "signingIn" ? 3_000 : 30_000);
    return () => clearInterval(timer);
  }, [refresh, status?.state]);

  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await run(); await refresh(true); }
    catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (mounted.current) setBusy(false); }
  }

  const quotaError = status?.state === "connected" ? codexQuotaError(status, model) : null;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4" aria-label="Codex subscription connection">
      <div>
        <p className="text-sm font-medium">Codex · ChatGPT 구독</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          ChatGPT 계정의 Codex 사용 한도를 함께 사용합니다. 한도 소진 시 요청을 중단하며 유료 API로 자동 전환하지 않습니다.
        </p>
      </div>
      <div className="text-xs" role="status" aria-live="polite">
        {!status ? "연결 상태 확인 중…" : status.state === "connected"
          ? `연결됨 · ${status.email || "ChatGPT"}${status.plan ? ` · ${status.plan}` : ""}`
          : status.state === "signingIn" ? "브라우저에서 ChatGPT 로그인을 완료해 주세요."
          : status.state === "unavailable" ? "Codex CLI 설치가 필요하거나 실행할 수 없습니다."
          : "ChatGPT 로그인이 필요합니다."}
      </div>
      {(error || status?.error) && <p className="text-xs text-destructive" role="alert">{error || status?.error}</p>}
      {quotaError && !status?.error && <p className="text-xs text-destructive" role="alert">{quotaError}</p>}
      <div className="flex flex-wrap gap-2">
        {status?.state === "connected" || status?.state === "error" ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => action(rpc.logoutCodex)}>로그아웃</Button>
        ) : status?.state === "signingIn" ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => action(rpc.cancelCodexLogin)}>로그인 취소</Button>
        ) : (
          <Button size="sm" disabled={busy || !status || status.state === "unavailable"} onClick={() => action(rpc.loginCodex)}>ChatGPT로 로그인</Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => refresh(true)}>새로고침</Button>
        {status?.state === "unavailable" && <Button size="sm" variant="link" onClick={() => rpc.openExternal("https://developers.openai.com/codex/cli")}>CLI 설치 안내</Button>}
      </div>
      <label className="block space-y-1.5 text-xs">
        <span className="font-medium">Sidebar Agent Model</span>
        <select aria-label="Codex model" value={model} disabled={status?.state !== "connected" || busy}
          onChange={event => onModelChange(event.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs">
          <option value="">Codex 기본 모델</option>
          {model && !models.includes(model) && <option value={model}>{model} (목록에서 확인되지 않음)</option>}
          {models.map(id => <option key={id} value={id}>{id}</option>)}
        </select>
      </label>
      {status?.quotas.map(quota => (
        <div key={quota.id} className="space-y-1 text-xs text-muted-foreground">
          <p className="font-medium">{quota.name}</p>
          {[quota.primary, quota.secondary].map((window, index) => window && (
            <p key={index}>
              {window.windowDurationMins ? window.windowDurationMins >= 1440 ? `${window.windowDurationMins / 1440}일 한도` : `${window.windowDurationMins / 60}시간 한도` : "사용 한도"}: {Math.max(0, 100 - window.usedPercent).toFixed(0)}% 남음
              {window.resetsAt ? ` · 초기화 ${new Date(window.resetsAt * 1000).toLocaleString()}` : ""}
            </p>
          ))}
        </div>
      ))}
      <p className="text-[11px] text-muted-foreground">로그인은 ScholarPen에 따로 저장됩니다. 모델 선택 후 Settings의 Save Settings를 눌러 적용하세요.</p>
    </div>
  );
}
