export function reviewStageLabel(stage: string): string {
  const labels: Record<string, string> = {
    'review-ready': '시작 준비 완료', preflight: '연결과 원고 확인', 'context-building': '원고 전체 문맥 분석',
    'manuscript-contract': '연구 질문·주장·설계 정리', 'importing-comments': '심사의견 정리',
    'initial-reviewing': '관점별 심사', finalizing: '최종 결과 저장', completed: '검토 완료',
  };
  if (labels[stage]) return labels[stage];
  const figures = /^(initial|round-(\d+))-figures-(\d+)$/.exec(stage);
  if (figures) return `${figures[2] ? figures[2] + '차 ' : '원본 '}그림 검토 · 묶음 ${figures[3]}`;
  if (/^figure-followup-/.test(stage)) return "그림 수정 확인 사항 기록";
  const reviewer = /^initial-(R\d+)$/.exec(stage);
  if (reviewer) return `${reviewer[1]} 관점의 심사`;
  const round = /^(planning|plan|applying|responding|responses|gpt-assessing|assessment|awaiting-figure-approval)(?:\((\d+)\)|-(\d+))$/.exec(stage);
  if (round) {
    const names: Record<string, string> = { planning: '수정 계획 작성', plan: '수정 계획 작성', applying: '수정안 검증·적용', responding: '답변서 작성', responses: '답변서 작성', 'gpt-assessing': '수정본·답변서 재검토', assessment: '수정본·답변서 재검토', 'awaiting-figure-approval': '그림 수정 승인 대기' };
    return `${round[2] ?? round[3]}차 ${names[round[1]!]}`;
  }
  return '검토 작업 처리';
}
export function elapsedLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}
