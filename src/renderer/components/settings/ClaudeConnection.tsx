import React, { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Selector } from "@astryxdesign/core/Selector";
import { ExternalLink, SettingsError, SettingsNote } from "./settings-kit";
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
  const connected = status?.state === "connected";
  return <section aria-label="Claude subscription connection"><Card variant="muted">
    <VStack gap={3}>
      <VStack gap={1}>
        <Heading level={4}>Claude · 구독 연결</Heading>
        <SettingsNote>공식 Claude Code를 통해 Claude 구독 한도를 함께 사용합니다. 유료 API로 자동 전환하지 않습니다.</SettingsNote>
      </VStack>
      {status?.cliVersion && <Text type="supporting" display="block"><span title={status.cliPath}>Claude Code {status.cliVersion}</span></Text>}
      <Text type="body" display="block" as="div" role="status" aria-live="polite">
        {!status ? "연결 상태 확인 중…" : connected ? `연결됨 · ${status.email || "Claude"}${status.plan ? ` · ${status.plan}` : ""}`
          : status.state === "signingIn" ? "브라우저에서 Claude 로그인을 완료해 주세요."
          : status.state === "unavailable" ? "Claude Code 설치 또는 업데이트가 필요합니다."
          : "Claude 구독 로그인이 필요합니다."}
      </Text>
      {(error || status?.error) && <SettingsError>{error || status?.error}</SettingsError>}
      <HStack gap={2} wrap="wrap">
        {status?.state === "signingIn" ? <Button label="로그인 취소" size="sm" variant="secondary" isDisabled={busy} onClick={() => action(rpc.cancelClaudeLogin)} />
          : <>
            <Button label={connected ? "계정 변경" : "Claude로 로그인"} size="sm" variant="primary" isDisabled={busy || !status || status.state === "unavailable"} onClick={() => action(rpc.loginClaude)} />
            {(connected || status?.state === "error") && <Button label="로그아웃" size="sm" variant="secondary" isDisabled={busy} onClick={() => action(rpc.logoutClaude)} />}
          </>}
        <Button label="새로고침" size="sm" variant="ghost" isDisabled={busy} onClick={() => action(refresh)} />
        {status?.state === "unavailable" && <ExternalLink href="https://code.claude.com/docs/en/setup">설치 안내</ExternalLink>}
      </HStack>
      <Selector
        label="Sidebar Agent Model"
        description="모델 접근 권한은 구독에 따라 다릅니다. 한도나 접근 권한 오류가 나면 요청을 중단합니다."
        value={model}
        isDisabled={!connected || busy}
        onChange={(next) => onModelChange(next ?? "")}
        options={[
          { value: "", label: "구독 기본 모델" },
          ...(model && !CLAUDE_MODELS.includes(model) ? [{ value: model, label: `${model} (저장된 모델)` }] : []),
          ...CLAUDE_MODELS.map(id => ({ value: id, label: id })),
        ]}
      />
      {status?.quota && <Text type="body" color="secondary" display="block" as="p">
        마지막 응답의 한도 상태: {status.quota.status === "rejected" ? "한도 도달" : status.quota.status === "allowed_warning" ? "한도에 가까움" : "사용 가능"}
        {status.quota.utilization !== undefined ? ` · ${Math.round(status.quota.utilization * 100)}% 사용` : ""}
        {status.quota.resetsAt ? ` · 초기화 ${new Date(status.quota.resetsAt * 1000).toLocaleString()}` : ""}
      </Text>}
      <SettingsNote>정확한 남은 한도는 Claude 계정의 사용량 페이지에서 확인하세요. 계정에서 별도로 켠 추가 사용 요금은 API 자동 전환과 별개입니다.</SettingsNote>
      <ExternalLink href="https://claude.ai/settings/usage">Claude 사용량 확인</ExternalLink>
      <SettingsNote>로그인은 ScholarPen 전용으로 공식 Claude Code가 관리합니다. 모델 선택 후 Save Settings를 눌러 적용하세요.</SettingsNote>
    </VStack>
  </Card></section>;
}
