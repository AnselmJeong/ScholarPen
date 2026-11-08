import type { AppliedChange, AuthorCheck, ResponseItem } from '../../shared/review-session/types';
export function mergeAuthorChecks(previous: AuthorCheck[], fresh: AuthorCheck[], changes: AppliedChange[]) {
  const pending = new Map([...previous, ...fresh].map(c => [`${c.target}\n${c.proposed}`, c]));
  return [...pending.values()].filter(c => !changes.some(change => change.target === c.target && change.after === c.proposed));
}
/** Report only applied evidence for affected comments. Never claim that a deferred edit was made. */
export function includeAuthorChecks(responses: ResponseItem[], checks: AuthorCheck[], changes: AppliedChange[], language: string) {
  const ko = /korean|한국|한글/i.test(language);
  for (const response of responses) {
    const pending = checks.filter(c => c.commentIds.includes(response.commentId));
    if (!pending.length) continue;
    const applied = changes.filter(c => c.commentIds.includes(response.commentId));
    response.disposition = applied.length ? 'partially-addressed' : 'needs-author';
    response.changeIds = applied.map(c => c.id);
    response.locations = [...new Set([...applied.map(c => c.target), ...pending.map(c => c.target)])];
    const actual = applied.length ? applied.map(c => `${c.target}\n${ko ? '적용 전' : 'Before'}: ${c.before}\n${ko ? '적용 후' : 'After'}: ${c.after}`).join('\n\n') : ko ? '이 의견과 관련해 자동으로 적용한 수정은 없습니다.' : 'No manuscript change has been applied automatically for this comment.';
    const notes = pending.map(c => c.kind === "response" || c.kind === "review" ? `${c.id} · ${c.target}\n${ko ? "저자 확인 필요: AI 답변 또는 계획의 근거·연결을 검증하지 못했습니다. 아래 초안은 확인되지 않은 참고 자료이며 완료된 수정의 증거가 아닙니다." : "Author confirmation required: the evidence or mapping of this AI response/plan could not be verified. The draft below is unverified reference material, not evidence of a completed revision."}\n${ko ? "확인 사유" : "Reason"}: ${c.reason}\n${ko ? "검증되지 않은 초안" : "Unverified draft"}: ${c.proposed || (ko ? "초안 누락" : "No draft supplied")}\n${ko ? "근거와 원고 위치를 확인한 후 답변을 완성해 주세요." : "Please verify the evidence and manuscript location before completing this response."}` : `${c.id} · ${c.target}\n${c.kind === 'figure' ? (ko ? '유지한 그림 파일' : 'Retained figure file') : (ko ? '현재 원문' : 'Preserved text')}: ${c.before}\n${ko ? '보류한 제안 — 미적용' : 'Deferred proposal — NOT applied'}: ${c.proposed}\n${ko ? '확인할 내용' : 'Proposed rationale to verify'}: ${c.rationale}\n${c.kind === 'figure' ? (ko ? '그림 수정은 적용하지 않았고 원본 그림을 유지했습니다. 저자가 수정 요구를 확인하고, 필요하면 새 그림을 제작하여 교체해 주세요.' : 'The figure revision has NOT been applied. The original figure has been retained. The author should review the requested revision and provide a replacement image if needed.') : ko ? '변경 근거 또는 원고 위치·기준 문장과의 일치를 자동 검증하지 못했습니다. 원문을 유지했습니다. 저자가 근거와 용어를 확인한 후 반영 여부를 결정해 주세요.' : 'The evidence or the match to the manuscript location and baseline wording could not be verified automatically. The original wording has been retained. Author confirmation of the evidence and terminology is required before applying this proposal.'}`).join('\n\n');
    response.response = `${ko ? '확인된 적용 내역' : 'Verified applied changes'}\n\n${actual}\n\n${ko ? '저자 확인 필요 — 제출 전 검토해 주세요' : 'Author confirmation required — review before submission'}\n\n${notes}`;
  }
}
