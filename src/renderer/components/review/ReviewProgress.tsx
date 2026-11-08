import React, { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, AlertCircle } from 'lucide-react';
import type { ReviewView } from '../../../shared/review-session/types';
import { elapsedLabel, reviewStageLabel } from '../../../shared/review-session/progress-labels';

export function ReviewProgress({ view, lastCheckedAt, connectionError }: { view: ReviewView; lastCheckedAt: number; connectionError: string }) {
  const [now, setNow] = useState(Date.now);
  const s = view.session; const p = view.progress; const running = s.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const stale = running && (Boolean(connectionError) || !lastCheckedAt || now - lastCheckedAt > 15_000);
  const call = running ? p?.activeCall : undefined;
  const clock = running ? now : Date.parse(s.updatedAt);
  const since = call?.startedAt ?? p?.stageStartedAt ?? s.updatedAt;
  const elapsed = Math.max(0, clock - Date.parse(since));
  const stage = call?.stage ?? s.stage;
  const authorChecks = (s.rounds.find(r => r.round === s.selectedFinalRound) ?? s.rounds.at(-1))?.authorChecks ?? [];
  const status = stale ? '상태 확인 지연' : s.status === 'completed' ? '자동 검토 완료' : s.status === 'failed' ? '오류로 중단됨' : s.status === 'paused' ? '일시정지됨' : s.status === 'cancelled' ? '취소됨' : running ? call ? (call.receivedCharacters ? '응답 수신 중' : '모델 응답 대기 중') : '작업 진행 중' : '시작 준비 완료';
  const description = stale ? '앱의 최신 상태를 받지 못했습니다. 아래 내용은 마지막으로 확인한 상태입니다.'
    : call ? `${call.provider === 'codex' ? 'GPT' : 'Claude'} ${call.model}에 요청했습니다. ${call.receivedCharacters ? '응답을 받고 있으며 완료 후 형식을 검증합니다.' : '전체 응답을 받으면 다음 단계로 넘어갑니다.'}`
    : s.status === 'completed' ? '자동 검토가 끝났습니다. 의견과 답변·답변서에서 최신 저장 답변을 확인하세요. 아래 확인 항목은 자동 검토 당시의 기록입니다.'
    : s.status === 'paused' && s.stage.startsWith('awaiting-figure') ? '대체 그림이 있으면 그림 확인 탭에서 파일을 선택하세요. 없으면 재개 시 원본을 유지하고 확인 사항으로 남깁니다.'
    : running ? '원고와 검토 결과를 처리하고 있습니다. 단계가 끝나면 자동으로 갱신됩니다.'
    : s.status === 'created' ? '심사·수정 시작 버튼을 누르면 검토를 시작합니다.' : '자동 진행이 멈췄습니다. 위의 안내를 확인해 주세요.';
  return <section aria-label="심사 진행 상황" className="mx-5 my-4 rounded-xl border border-primary/20 bg-primary/5 p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-1 gap-3">
        {running && !stale ? <Loader2 aria-hidden size={18} className="mt-1 shrink-0 animate-spin motion-reduce:animate-none text-primary" /> : s.status === 'completed' ? <CheckCircle2 aria-hidden size={18} className="mt-1 shrink-0 text-primary" /> : <AlertCircle aria-hidden size={18} className="mt-1 shrink-0 text-muted-foreground" />}
        <div className="min-w-0"><p role="status" className="text-xs font-medium text-primary">{status}</p><h2 className="mt-1 text-base font-semibold">{s.status === 'completed' ? '자동 검토 당시 기록' : reviewStageLabel(stage)}</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p></div>
      </div>
      {running && <div className="text-right text-xs tabular-nums text-muted-foreground"><p>{call ? '현재 요청' : '현재 단계'} 경과 <strong className="text-foreground">{elapsedLabel(elapsed)}</strong></p>{p?.runStartedAt && <p className="mt-1">이번 실행 {elapsedLabel(clock - Date.parse(p.runStartedAt))}</p>}</div>}
    </div>
    <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-primary/10 pt-3 text-xs text-muted-foreground">
      <span>원고 {s.input.documents.length}개 · 완료 {s.completedCycles}/{s.input.maxCycles}회</span>
      {call && <span>{call.attempt === 1 ? '첫 요청' : `응답 형식 복구 ${call.attempt - 1}/2회`}{call.receivedCharacters ? ` · ${call.receivedCharacters.toLocaleString()}자 수신` : ''}</span>}
      {running && <span>{stale ? '연결 상태를 다시 확인하는 중' : `앱 연결 확인 · ${elapsedLabel(now - lastCheckedAt)} 전`}</span>}
      {call?.lastOutputAt && <span>최근 응답 수신 · {elapsedLabel(now - Date.parse(call.lastOutputAt))} 전</span>}
    </div>
    {call && elapsed >= 60_000 && <p className="mt-3 text-xs leading-5 text-muted-foreground">{elapsed >= call.timeoutMs ? '응답 제한 시간을 넘겼습니다. 종료 상태를 확인 중입니다.' : `긴 원고는 응답에 수분이 걸릴 수 있습니다. 요청당 최대 ${Math.round(call.timeoutMs / 60_000)}분 후 중단되며, 필요하면 일시정지할 수 있습니다.`} 앱 연결 확인은 모델의 내부 진행률을 뜻하지 않습니다.</p>}
    {!!authorChecks.length && <p className="mt-3 rounded-lg bg-amber-500/10 p-3 text-sm">자동 검토 당시 확인 요청 {authorChecks.length}건 · 근거가 부족한 수정·답변은 확인 항목으로 남겼습니다. 당시 적용 내역과 확인 사유는 계획·검증 탭과 편집 화면의 AI 검토 기록에서 볼 수 있습니다.</p>}
    {!!s.warnings?.length && <p className="mt-3 rounded-lg bg-amber-500/10 p-3 text-sm">자동 검토 한계 {s.warnings.length}건 · 가능한 작업은 계속 진행합니다. 완료하지 못한 단계는 계획·검증 탭에 기록됩니다.</p>}
    {p?.lastCompleted && <p className="mt-3 text-xs text-muted-foreground">최근 완료: {reviewStageLabel(p.lastCompleted.stage)} · {new Date(p.lastCompleted.at).toLocaleTimeString()}</p>}
    {!!p?.recent.length && <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">최근 작업 기록</summary><ol className="mt-2 space-y-1">{p.recent.map((e, i) => <li key={`${e.at}-${i}`} className="flex gap-3"><time className="shrink-0 tabular-nums">{new Date(e.at).toLocaleTimeString()}</time><span>{reviewStageLabel(e.stage)} · {({ 'run-start': '실행 시작', 'stage-start': '단계 시작', 'model-start': '모델 요청', 'model-complete': '응답 검증 완료', 'model-error': '요청 오류', 'schema-error': '응답 형식 확인 실패', 'cache-used': '저장된 결과 재사용', 'review-warning': '검토 한계 기록 · 계속 진행', 'author-check': '답변서에 확인 요청', stopped: '중단' } as Record<string, string>)[e.kind] ?? '상태 갱신'}</span></li>)}</ol></details>}
  </section>;
}
