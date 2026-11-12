import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Selector } from "@astryxdesign/core/Selector";
import { ExternalLink, SettingsError, SettingsNote } from "./settings-kit";
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

  const refresh = useCallback(async (reloadModels = false, reconnect = false) => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const next = await rpc.getCodexStatus(reconnect);
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

  async function refreshConnection() {
    setBusy(true);
    try { await refresh(true, true); }
    finally { if (mounted.current) setBusy(false); }
  }

  const quotaError = status?.state === "connected" ? codexQuotaError(status, model) : null;
  const connected = status?.state === "connected";
  return (
    <section aria-label="Codex subscription connection"><Card variant="muted">
      <VStack gap={3}>
        <VStack gap={1}>
          <Heading level={4}>Codex · ChatGPT 구독</Heading>
          <SettingsNote>
            ChatGPT 계정의 Codex 사용 한도를 함께 사용합니다. 한도 소진 시 요청을 중단하며 유료 API로 자동 전환하지 않습니다.
          </SettingsNote>
        </VStack>
        {status?.cliPath && <Text type="supporting" display="block"><span title={status.cliPath}>Codex CLI {status.cliVersion || "버전 확인 불가"}</span></Text>}
        <Text type="body" display="block" as="div" role="status" aria-live="polite">
          {!status ? "연결 상태 확인 중…" : connected
            ? `연결됨 · ${status.email || "ChatGPT"}${status.plan ? ` · ${status.plan}` : ""}`
            : status.state === "signingIn" ? "브라우저에서 ChatGPT 로그인을 완료해 주세요."
            : status.state === "unavailable" ? "Codex CLI 설치가 필요하거나 실행할 수 없습니다."
            : "ChatGPT 로그인이 필요합니다."}
        </Text>
        {(error || status?.error) && <SettingsError>{error || status?.error}</SettingsError>}
        {quotaError && !status?.error && <SettingsError>{quotaError}</SettingsError>}
        <HStack gap={2} wrap="wrap">
          {connected || status?.state === "error" ? (
            <Button label="로그아웃" size="sm" variant="secondary" isDisabled={busy} onClick={() => action(rpc.logoutCodex)} />
          ) : status?.state === "signingIn" ? (
            <Button label="로그인 취소" size="sm" variant="secondary" isDisabled={busy} onClick={() => action(rpc.cancelCodexLogin)} />
          ) : (
            <Button label="ChatGPT로 로그인" size="sm" variant="primary" isDisabled={busy || !status || status.state === "unavailable"} onClick={() => action(rpc.loginCodex)} />
          )}
          <Button label="새로고침" size="sm" variant="ghost" isDisabled={busy} onClick={refreshConnection} />
          {status?.state === "unavailable" && <ExternalLink href="https://developers.openai.com/codex/cli">CLI 설치 안내</ExternalLink>}
        </HStack>
        <SettingsNote>CLI 업데이트 후 새로고침하면 최신 실행 파일로 다시 연결하고 모델 목록을 불러옵니다.</SettingsNote>
        <Selector
          label="Sidebar Agent Model"
          value={model}
          isDisabled={!connected || busy}
          hasSearch={models.length > 8}
          onChange={(next) => onModelChange(next ?? "")}
          options={[
            { value: "", label: "Codex 기본 모델" },
            ...(model && !models.includes(model) ? [{ value: model, label: `${model} (목록에서 확인되지 않음)` }] : []),
            ...models.map(id => ({ value: id, label: id })),
          ]}
        />
        {status?.quotas.map(quota => (
          <VStack key={quota.id} gap={0.5}>
            <Text type="label" display="block">{quota.name}</Text>
            {[quota.primary, quota.secondary].map((window, index) => window && (
              <Text key={index} type="supporting" display="block" as="p" hasTabularNumbers>
                {window.windowDurationMins ? window.windowDurationMins >= 1440 ? `${window.windowDurationMins / 1440}일 한도` : `${window.windowDurationMins / 60}시간 한도` : "사용 한도"}: {Math.max(0, 100 - window.usedPercent).toFixed(0)}% 남음
                {window.resetsAt ? ` · 초기화 ${new Date(window.resetsAt * 1000).toLocaleString()}` : ""}
              </Text>
            ))}
          </VStack>
        ))}
        <SettingsNote>로그인은 ScholarPen에 따로 저장됩니다. 모델 선택 후 Settings의 Save Settings를 눌러 적용하세요.</SettingsNote>
      </VStack>
    </Card></section>
  );
}
