import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReviewSession } from '../../shared/review-session/types';
import { REVIEW_CATEGORIES } from '../../shared/collab/review';
import { copyPackage, scopedPath, exists, readJSON, writeJSON, atomicWrite, manifest } from './workspace';

/** Publish once. Reopening never replaces the author's edits with the sealed result. */
export async function ensureEditableRevision(root: string, session: ReviewSession): Promise<string> {
  const result = session.rounds.find(r => r.round === session.selectedFinalRound);
  if (!result) throw new Error('완료된 수정 결과가 없습니다.');
  const relativePath = `revisions/${session.id}`;
  const destination = await scopedPath(session.input.projectPath, relativePath);
  if (await exists(session.input.projectPath, relativePath)) {
    const origin = await readJSON<{ sessionId: string; baselineHash: string }>(destination, '.scholarpen/review-origin.json');
    if (origin.sessionId !== session.id || origin.baselineHash !== result.packageHash) throw new Error('수정 원고 폴더가 다른 자료와 충돌합니다. 기존 파일을 덮어쓰지 않았습니다.');
    session.editablePath = destination;
    return destination;
  }
  const source = join(root, 'final/project');
  if ((await manifest(source)).packageHash !== result.packageHash) throw new Error('Final package integrity mismatch');
  const temp = await scopedPath(session.input.projectPath, `revisions/.creating-${randomUUID()}`);
  await mkdir(temp, { recursive: true });
  await copyPackage(source, temp);
  for (const name of ['response-to-reviewers.md', 'response.json', 'change-summary.md', 'author-checks.json', 'review-warnings.json', 'unresolved-issues.md', 'quality-report.md']) {
    if (await exists(root, `final/${name}`)) {
      const { readFile } = await import('node:fs/promises');
      await atomicWrite(temp, name, await readFile(await scopedPath(root, `final/${name}`)));
    }
  }
  await writeJSON(temp, '.scholarpen/review-origin.json', { schemaVersion: 1, sessionId: session.id, round: session.selectedFinalRound, baselineHash: result.packageHash, verification: 'stale-after-manual-edit', responseRequiresRevalidation: true });
  await writeJSON(temp, '.scholarpen/review-settings.json', { disabledCategories: REVIEW_CATEGORIES.map(c => c.id) });
  await atomicWrite(temp, 'README.md', '# 수정 원고 작업 폴더\n\n이 폴더의 documents 안에 있는 원고를 ScholarPen Explorer에서 열어 편집하세요. 자동 저장은 이 사본에만 반영됩니다. figures와 exports/references.bib는 이 사본 전용입니다.\n\n답변서·변경표는 자동 검토 완료 시점의 자료입니다. 수동 편집 후에는 답변서와 원고의 일치를 다시 확인하세요. 원본과 내부 검토 기록은 변경되지 않습니다.\n');
  await rename(temp, destination);
  session.editablePath = destination;
  return destination;
}
