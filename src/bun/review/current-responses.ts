import type { ReviewSession, RoundResult, ReviewResponseDocument } from '../../shared/review-session/types';
import { exists, readJSON, scopedPath } from './workspace';
import { readEditableResponses, waitForResponseSaves } from './revision-responses';

/** Resolve the working copy by session identity, never by an arbitrary saved absolute path. */
export async function currentResponses(project: string, session: ReviewSession, result: RoundResult): Promise<ReviewResponseDocument> {
  const relative = `revisions/${session.id}`;
  if (session.status !== 'completed' || !await exists(project, relative)) {
    if (session.status === 'completed' && session.editablePath) throw new Error('수정 답변서 폴더를 찾을 수 없습니다. 이전 AI 답변으로 대체하지 않았습니다.');
    return { source: 'review', responses: result.responses, editedCommentIds: [] };
  }
  const path = await scopedPath(project, relative);
  const origin = await readJSON<{ sessionId: string; round: number; baselineHash: string }>(path, '.scholarpen/review-origin.json');
  if (origin.sessionId !== session.id || origin.round !== result.round || origin.baselineHash !== result.packageHash) throw new Error('수정 답변서의 검토 기준이 일치하지 않습니다. 작업 폴더를 확인해 주세요.');
  await waitForResponseSaves(path);
  const responses = await readEditableResponses(path, result);
  return { source: 'revision', path, responses, editedCommentIds: responses.filter(response => {
    const original = result.responses.find(item => item.commentId === response.commentId);
    return response.response !== original?.response || response.verification !== original?.verification;
  }).map(response => response.commentId) };
}
