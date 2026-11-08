import { expect, test } from 'bun:test';
import { progressFromJournal } from './progress';
import type { ReviewSession } from '../../shared/review-session/types';
import { reviewStageLabel } from '../../shared/review-session/progress-labels';
const session = { status: 'running' } as ReviewSession;
const at='2026-10-26T07:09:32.000Z';
const start={at,kind:'model-start',stage:'manuscript-contract',provider:'codex',model:'gpt-test',attempt:1,prompt:'private content'};
const lines=(...events: unknown[])=>events.map(e=>JSON.stringify(e)).join('\n');
test('legacy journal reports pending request and whitelists operational metadata',()=>{
 const p=progressFromJournal(session, lines(start)+'\n{partial');
 expect(p.activeCall?.model).toBe('gpt-test'); expect(p.activeCall?.startedAt).toBe(at);
 expect(JSON.stringify(p)).not.toContain('private content'); expect(p.activeCall?.timeoutMs).toBe(720000);
});
test('stream activity, retries, completion and stopping never leave an old call running',()=>{
 const live={stage:start.stage,startedAt:at,receivedCharacters:120,lastOutputAt:at};
 expect(progressFromJournal(session,lines(start),live).activeCall?.receivedCharacters).toBe(120);
 const complete={at,kind:'model-complete',stage:start.stage};
 expect(progressFromJournal(session,lines(start,complete)).activeCall).toBeUndefined();
 expect(progressFromJournal(session,lines(start,complete)).lastCompleted?.stage).toBe(start.stage);
 expect(progressFromJournal(session,lines(start,{at,kind:'schema-error',stage:start.stage},{...start,attempt:2})).activeCall?.attempt).toBe(2);
 expect(progressFromJournal({...session,status:'paused'},lines(start)).activeCall).toBeUndefined();
 expect(progressFromJournal(session,lines(start,{at,kind:'run-start',stage:'preflight'})).activeCall).toBeUndefined();
});
test('stage labels describe figure batches and revision rounds',()=>{
 expect(reviewStageLabel('round-2-figures-3')).toBe('2차 그림 검토 · 묶음 3');
 expect(reviewStageLabel('planning(1)')).toBe('1차 수정 계획 작성');
 expect(reviewStageLabel('responses-2')).toBe('2차 답변서 작성');
});
