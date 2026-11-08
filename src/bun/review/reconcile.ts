import type { AppliedChange, Assessment, AuthorCheck, ReviewComment, ReviewContext, RevisionPlan, ResponseItem } from '../../shared/review-session/types';

/** Content deficiencies are author follow-ups, never permission to invent evidence. */
export function reviewCheck(id: string, target: string, comments: ReviewComment[], proposed: string, reason: string, kind: 'review' | 'response' = 'review'): AuthorCheck {
  return { kind, id, target, before: comments.map(c => c.original).join('\n\n'), proposed, commentIds: comments.map(c => c.id), rationale: reason, reason };
}
export function reconcilePlan(plan: RevisionPlan, comments: ReviewComment[], context: ReviewContext, round: number) {
  const checks: AuthorCheck[] = [];
  const known = (ids: string[]) => ids.length > 0 && ids.every(id => comments.some(c => c.id === id));
  const affected = (ids: string[]) => { const found = comments.filter(c => ids.includes(c.id)); return found.length ? found : comments; };
  const add = (target: string, ids: string[], proposal: unknown, reason: string) => checks.push(reviewCheck(`PLAN${round}-${checks.length + 1}`, target, affected(ids), JSON.stringify(proposal), reason));
  const decisions = comments.map(c => {
    const matches = plan.decisions.filter(d => d.commentId === c.id);
    if (matches.length === 1 && matches[0]!.reason.trim()) return matches[0]!;
    add(c.id, [c.id], matches, 'The revision plan omitted this comment or supplied conflicting/empty decisions. Author review is required.');
    return { commentId: c.id, disposition: 'needs-author' as const, reason: 'Incomplete revision decision; author review required.' };
  });
  for (const d of plan.decisions.filter(d => !known([d.commentId]))) add(d.commentId, [], d, 'The plan refers to an unknown review comment. It has not been assigned to an original comment.');
  const patches = plan.patches.filter(p => {
    if (known(p.commentIds) && plan.patches.filter(other => other.id === p.id).length === 1) return true;
    add(p.kind === 'set-text' ? p.slotId : `${p.document}#${p.blockId}`, p.commentIds, p, 'This edit has ambiguous change IDs or unknown comment references. It was not applied.'); return false;
  });
  const figures = plan.figures.filter(f => {
    if (known(f.commentIds) && context.figures.some(x => x.id === f.figureId) && plan.figures.filter(x => x.figureId === f.figureId).length === 1) return true;
    add(f.figureId, f.commentIds, f, 'This figure request has an unknown target/comment or conflicting duplicate requests. The original figure was retained.'); return false;
  });
  return { plan: { ...plan, decisions, patches, figures }, checks };
}
export function reconcileResponses(drafts: ResponseItem[], comments: ReviewComment[], changes: AppliedChange[], round: number) {
  const checks: AuthorCheck[] = [];
  const responses = comments.map(c => {
    const matches = drafts.filter(r => r.commentId === c.id);
    const r = matches[0]; const reasons: string[] = [];
    if (matches.length !== 1) reasons.push('A unique response for this original comment was not supplied.');
    if (r) {
      if (!r.response.trim()) reasons.push('The draft response is empty.');
      if (r.changeIds.some(id => !changes.some(x => x.id === id && x.commentIds.includes(c.id)))) reasons.push('The draft cites changes that were not applied to this comment.');
      if (r.disposition === 'changed' && !r.changeIds.length) reasons.push('The draft claims a completed revision without applied-change evidence.');
      if (['clarified-no-change', 'reasoned-disagreement'].includes(r.disposition) && !r.locations.some(x => x.trim())) reasons.push('The draft proposes no change but supplies no manuscript location or quoted evidence.');
      if (r.disposition === 'awaiting-figure-approval') reasons.push('The requested figure revision needs author follow-up; review execution can continue.');
    }
    if (reasons.length) checks.push(reviewCheck(`RESPONSE${round}-${c.id}`, c.id, [c], matches.map(x => x.response).join('\n\n'), reasons.join(' '), 'response'));
    return r ? { ...r, locations: r.locations.filter(x => x.trim()) } : { commentId: c.id, disposition: 'needs-author' as const, response: '', changeIds: [], locations: [], verification: 'not-assessed' as const };
  });
  // Preserve unmatched drafts as explicitly unassigned material, not fabricated reviewer comments.
  const extras = drafts.filter(r => !comments.some(c => c.id === r.commentId));
  if (extras.length) checks.push(reviewCheck(`RESPONSE${round}-unassigned`, 'Unassigned response drafts', comments, JSON.stringify(extras), 'These drafts refer to unknown comment IDs. Confirm their intended mapping before using them.', 'response'));
  return { responses, checks };
}
export function reconcileAssessment(assessment: Assessment, comments: ReviewComment[], checks: AuthorCheck[]): Assessment {
  const issues = [...assessment.issues];
  const entries = comments.map(c => {
    const matches = assessment.comments.filter(x => x.commentId === c.id);
    if (matches.length !== 1 || !matches[0]!.reason.trim()) {
      const reason = `${c.id}: Automated verification is missing, duplicated or empty. Author verification is required.`;
      issues.push(reason); return { commentId: c.id, verification: 'not-verified' as const, reason };
    }
    const entry = matches[0]!;
    if (checks.some(x => x.commentIds.includes(c.id)) && entry.verification === 'verified') return { ...entry, verification: 'not-verified' as const, reason: 'Author follow-ups remain unresolved. ' + entry.reason };
    return entry;
  });
  if (assessment.comments.some(x => !comments.some(c => c.id === x.commentId))) issues.push('The assessment included unknown comment IDs; those entries were not used.');
  return { ...assessment, issues, comments: entries };
}
