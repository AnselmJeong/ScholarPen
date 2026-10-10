import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { CLAUDE_MODELS } from "@shared/claude";
import { rpc } from "../../rpc";
import { useClaudeStatus } from "../../hooks/useClaudeStatus";

export function ClaudeConnection({ model, onModelChange }: { model: string; onModelChange: (model: string) => void }) {
  const { status, refresh } = useClaudeStatus(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function action(run: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await run(); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4" aria-label="Claude subscription connection">
    <div>
      <p className="text-sm font-medium">Claude · 구독 연결</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">공식 Claude Code를 통해 Claude 구독 한도를 함께 사용합니다. 유료 API로 자동 전환하지 않습니다.</p>
    </div>
    {status?.cliVersion && <p className="text-[11px] text-muted-foreground" title={status.cliPath}>Claude Code {status.cliVersion}</p>}
    <div className="text-xs" role="status" aria-live="polite">
      {!status ? "연결 상태 확인 중…" : status.state === "connected" ? `연결됨 · ${status.email || "Claude"}${status.plan ? ` · ${status.plan}` : ""}`
        : status.state === "signingIn" ? "브라우저에서 Claude 로그인을 완료해 주세요."
        : status.state === "unavailable" ? "Claude Code 설치 또는 업데이트가 필요합니다."
        : "Claude 구독 로그인이 필요합니다."}
    </div>
    {(error || status?.error) && <p role="alert" className="text-xs text-destructive">{error || status?.error}</p>}
    <div className="flex flex-wrap gap-2">
      {status?.state === "signingIn" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => action(rpc.cancelClaudeLogin)}>로그인 취소</Button>
        : <>
          <Button size="sm" disabled={busy || !status || status.state === "unavailable"} onClick={() => action(rpc.loginClaude)}>{status?.state === "connected" ? "계정 변경" : "Claude로 로그인"}</Button>
          {(status?.state === "connected" || status?.state === "error") && <Button size="sm" variant="outline" disabled={busy} onClick={() => action(rpc.logoutClaude)}>로그아웃</Button>}
        </>}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => action(refresh)}>새로고침</Button>
      {status?.state === "unavailable" && <Button size="sm" variant="link" onClick={() => rpc.openExternal("https://code.claude.com/docs/en/setup")}>설치 안내</Button>}
    </div>
    <label className="block space-y-1.5 text-xs">
      <span className="font-medium">Sidebar Agent Model</span>
      <select aria-label="Claude model" value={model} disabled={status?.state !== "connected" || busy} onChange={event => onModelChange(event.target.value)}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs">
        <option value="">구독 기본 모델</option>
        {model && !CLAUDE_MODELS.includes(model) && <option value={model}>{model} (저장된 모델)</option>}
        {CLAUDE_MODELS.map(id => <option key={id} value={id}>{id}</option>)}
      </select>
    </label>
    <p className="text-[11px] text-muted-foreground">모델 접근 권한은 구독에 따라 다릅니다. 한도나 접근 권한 오류가 나면 요청을 중단합니다.</p>
    {status?.quota && <p className="text-xs text-muted-foreground">
      마지막 응답의 한도 상태: {status.quota.status === "rejected" ? "한도 도달" : status.quota.status === "allowed_warning" ? "한도에 가까움" : "사용 가능"}
      {status.quota.utilization !== undefined ? ` · ${Math.round(status.quota.utilization * 100)}% 사용` : ""}
      {status.quota.resetsAt ? ` · 초기화 ${new Date(status.quota.resetsAt * 1000).toLocaleString()}` : ""}
    </p>}
    <p className="text-[11px] leading-relaxed text-muted-foreground">정확한 남은 한도는 Claude 계정의 사용량 페이지에서 확인하세요. 계정에서 별도로 켠 추가 사용 요금은 API 자동 전환과 별개입니다.</p>
    <Button size="sm" variant="link" onClick={() => rpc.openExternal("https://claude.ai/settings/usage")}>Claude 사용량 확인</Button>
    <p className="text-[11px] text-muted-foreground">로그인은 ScholarPen 전용으로 공식 Claude Code가 관리합니다. 모델 선택 후 Save Settings를 눌러 적용하세요.</p>
  </div>;
}
