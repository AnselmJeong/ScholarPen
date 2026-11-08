import { expect, test } from 'bun:test';
import { ResponseDrafts } from './response-drafts';
import type { RevisionResponseSave } from '../../../shared/review-session/chapter-context';
const request = { projectPath: '/paper/revisions/session', filename: 'intro.scholarpen.json', commentId: 'R1-C1', response: 'First edit', expectedResponse: 'AI answer' };
test('typing during a save queues the newest draft with the correct base after chapter changes', async () => {
  let finish!: (value: string) => void;
  const calls: RevisionResponseSave[] = [];
  const drafts = new ResponseDrafts(async r => { calls.push(r); if (calls.length === 1) return new Promise(resolve => { finish = resolve; }); return r.response; }, 10_000);
  const key = drafts.key(request.projectPath, request.commentId);
  drafts.change(request); const saving = drafts.flush(key);
  drafts.change({ ...request, filename: 'discussion.scholarpen.json', response: 'Newest edit' });
  finish('First edit'); await saving;
  expect(calls.map(c => [c.response, c.expectedResponse])).toEqual([['First edit', 'AI answer'], ['Newest edit', 'First edit']]);
  expect(drafts.get(key)!.text).toBe('Newest edit'); expect(drafts.hasPending()).toBe(false);
});
test('failed save keeps the draft and explicit retry persists it', async () => {
  let fail = true;
  const drafts = new ResponseDrafts(async r => { if (fail) throw Error('Disk unavailable'); return r.response; }, 10_000);
  const key = drafts.key(request.projectPath, request.commentId);
  drafts.change(request); await drafts.flush(key);
  expect(drafts.get(key)!.text).toBe('First edit'); expect(drafts.get(key)!.error).toContain('Disk unavailable'); expect(drafts.hasPending()).toBe(true);
  fail = false; await drafts.flush(key); expect(drafts.hasPending()).toBe(false); expect(drafts.get(key)!.error).toBe('');
});
test('same comment in different sessions has independent drafts', async () => {
  const drafts = new ResponseDrafts(async r => r.response, 10_000);
  drafts.change(request); drafts.change({ ...request, projectPath: '/another/revisions/session', response: 'Other edit' });
  await drafts.flushAll();
  expect(drafts.get(drafts.key(request.projectPath, request.commentId))!.text).toBe('First edit');
  expect(drafts.get(drafts.key('/another/revisions/session', request.commentId))!.text).toBe('Other edit');
});

test('opening Review waits for an in-flight save and the newest queued edit', async () => {
  let finish!: (value: string) => void;
  const calls: string[] = [];
  const drafts = new ResponseDrafts(async r => { calls.push(r.response); if (calls.length === 1) return new Promise(resolve => { finish = resolve; }); return r.response; }, 10_000);
  drafts.change(request); void drafts.flush(drafts.key(request.projectPath, request.commentId));
  drafts.change({ ...request, response: 'Final answer before export' });
  let prepared = false;
  const preparing = drafts.prepareReview('/paper').then(() => { prepared = true; });
  await Promise.resolve(); expect(prepared).toBe(false);
  finish('First edit'); await preparing;
  expect(calls).toEqual(['First edit', 'Final answer before export']); expect(drafts.hasPending()).toBe(false);
});

test('failed saves block Review export while keeping author input and unrelated drafts isolated', async () => {
  const drafts = new ResponseDrafts(async () => { throw Error('Disk full'); }, 10_000);
  drafts.change(request);
  await drafts.prepareReview('/other-project');
  await expect(drafts.prepareReview('/paper')).rejects.toThrow('답변을 저장하지 못했습니다');
  expect(drafts.get(drafts.key(request.projectPath, request.commentId))!.text).toBe(request.response);
});
