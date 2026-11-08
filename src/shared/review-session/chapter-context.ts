import type { AppliedChange, AuthorCheck, ReviewAddress, ReviewComment, ResponseItem, ReviewSession, RoundResult } from './types';
export interface RevisionChapterContext {
  original?: unknown[];
  /** Current author-editable responses; immutable AI responses remain in comments. */
  editableResponses?: ResponseItem[];
  address: ReviewAddress; filename: string; round: number; changes: AppliedChange[]; checks: AuthorCheck[];
  comments: { comment: ReviewComment; response?: ResponseItem; scope: 'chapter' | 'unlocated' }[];
}
export interface RevisionResponseSave {
  projectPath: string; filename: string; commentId: string; response: string; expectedResponse: string;
}
export const targetsDocument = (target: string, document: string) => target === document || target.startsWith(`${document}#`) || target.startsWith(`${document}:`) || target === `documents/${document}` || target.startsWith(`documents/${document}#`);
export function chapterContext(session: ReviewSession, result: RoundResult, filename: string, projectPath: string): RevisionChapterContext {
  const changes = result.changes.filter(c => targetsDocument(c.target, filename));
  const comments: RevisionChapterContext['comments'] = [];
  for (const comment of session.comments) {
    const response = result.responses.find(r => r.commentId === comment.id);
    const targets = [...comment.targets, ...(response?.locations ?? []), ...result.changes.filter(c => c.commentIds.includes(comment.id)).map(c => c.target), ...(result.authorChecks ?? []).filter(c => c.commentIds.includes(comment.id)).map(c => c.target)];
    const documents = session.input.documents.filter(d => targets.some(t => targetsDocument(t, d)));
    if (documents.includes(filename)) comments.push({ comment, response, scope: 'chapter' });
    else if (!documents.length) comments.push({ comment, response, scope: 'unlocated' });
  }
  const ids = new Set(comments.map(c => c.comment.id));
  return { address: { projectPath, sessionId: session.id }, filename, round: result.round, changes, comments,
    checks: (result.authorChecks ?? []).filter(c => targetsDocument(c.target, filename) || c.commentIds.some(id => ids.has(id))) };
}
