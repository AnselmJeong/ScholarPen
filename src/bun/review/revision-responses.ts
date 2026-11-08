import type { ResponseItem, ReviewSession, RoundResult } from '../../shared/review-session/types';
import { chapterContext, type RevisionResponseSave } from '../../shared/review-session/chapter-context';
import { atomicWrite, readJSON, writeJSON, exists, scopedPath, hash } from './workspace';
import { readFile } from 'node:fs/promises';
import { responseLetterMarkdown } from '../../shared/review-session/response-letter';

// Serialize read/merge/write across chapters so two saves cannot erase each other.
const pending = new Map<string, Promise<unknown>>();
export async function waitForResponseSaves(root: string): Promise<void> {
  while (pending.has(root)) await pending.get(root);
}
export async function readEditableResponses(root: string, result: RoundResult): Promise<ResponseItem[]> {
  const saved = await readJSON<{ responses: ResponseItem[] }>(root, 'response.json');
  if (!Array.isArray(saved.responses) || saved.responses.some(r => !r || typeof r.response !== 'string' || typeof r.commentId !== 'string')
    || new Set(saved.responses.map(r => r.commentId)).size !== saved.responses.length
    || result.responses.some(r => !saved.responses.some(item => item.commentId === r.commentId))) {
    throw new Error('작업 답변서의 형식을 확인해 주세요. 기존 내용을 덮어쓰지 않았습니다.');
  }
  return result.responses.map(r => {
    const current = saved.responses.find(item => item.commentId === r.commentId);
    return current ? { ...r, ...current } : r;
  });
}

export async function saveRevisionResponse(root: string, session: ReviewSession, result: RoundResult, input: RevisionResponseSave): Promise<string> {
  const previous = pending.get(root) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    if (typeof input.response !== 'string' || typeof input.expectedResponse !== 'string' || input.response.length > 500_000) throw new Error('답변은 500,000자 이내의 텍스트여야 합니다.');
    const allowed = chapterContext(session, result, input.filename, session.input.projectPath).comments;
    if (!allowed.some(c => c.comment.id === input.commentId)) throw new Error('현재 장에 연결된 심사의견이 아닙니다.');
    const responses = await readEditableResponses(root, result);
    const response = responses.find(r => r.commentId === input.commentId);
    if (!response) throw new Error('저장할 답변을 찾을 수 없습니다.');
    if (response.response !== input.expectedResponse && response.response !== input.response) throw new Error('다른 곳에서 이 답변을 수정했습니다. 입력한 내용은 유지됩니다. 최신 답변을 확인한 후 다시 저장해 주세요.');
    // Preserve Markdown edited directly outside this form before regenerating it.
    if (await exists(root, 'response-to-reviewers.md')) {
      const markdown = await readFile(await scopedPath(root, 'response-to-reviewers.md'), 'utf8');
      if (markdown !== responseLetterMarkdown(session, responses)) {
        await atomicWrite(root, `.scholarpen/response-backups/${hash(markdown)}.md`, markdown);
      }
    }
    response.response = input.response;
    response.verification = 'not-verified';
    // JSON is canonical. An idempotent retry also repairs Markdown if its write failed.
    await writeJSON(root, 'response.json', { schemaVersion: 1, authorEdited: true, updatedAt: new Date().toISOString(), responses });
    await atomicWrite(root, 'response-to-reviewers.md', responseLetterMarkdown(session, responses));
    return response.response;
  });
  pending.set(root, operation);
  try { return await operation; }
  finally { if (pending.get(root) === operation) pending.delete(root); }
}
