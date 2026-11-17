import type { ReviewSession, RoundResult, ReviewResponseDocument } from '../../shared/review-session/types';
import type { SessionStore } from './session-store';
import { readEditableResponses, waitForResponseSaves } from './revision-responses';
import { existingLetter, letterMatches } from './letter';
import { overlayLetterDocument, readLetterRecord } from './letter-document';

/** The letter as it now stands: the session's edited letter once there is one, else the review's own answers. */
export async function currentResponses(store: SessionStore, session: ReviewSession, result: RoundResult): Promise<ReviewResponseDocument> {
  const path = session.status === 'completed' ? await existingLetter(store, session) : null;
  if (!path) {
    // A letter that existed (or an older session's copy) is gone: never pass the AI's first answers off as the letter.
    if (session.status === 'completed' && (session.editablePath || session.letterAt)) throw new Error('수정 답변서 폴더를 찾을 수 없습니다. 이전 AI 답변으로 대체하지 않았습니다.');
    return { source: 'review', responses: result.responses, editedCommentIds: [] };
  }
  if (!await letterMatches(path, session, result)) throw new Error('수정 답변서의 검토 기준이 일치하지 않습니다. 작업 폴더를 확인해 주세요.');
  await waitForResponseSaves(path);
  // The letter document, once the author opened one, is the letter: its wording wins.
  const responses = await overlayLetterDocument(store.project, path, session, await readEditableResponses(path, result));
  const letterDocument = (await readLetterRecord(path))?.filename;
  return { source: 'revision', path, responses, ...(letterDocument ? { letterDocument } : {}), editedCommentIds: responses.filter(response => {
    const original = result.responses.find(item => item.commentId === response.commentId);
    return response.response !== original?.response || response.verification !== original?.verification;
  }).map(response => response.commentId) };
}
