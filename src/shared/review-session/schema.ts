import type { Assessment, ReviewInput, RevisionPlan, ResponseItem, Disposition, PatchOperation } from "./types";
export function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Expected an object."); return v as Record<string, unknown>; }
export function string(v: unknown): string { if (typeof v !== "string") throw new Error("Expected text."); return v; }
export function array(v: unknown): unknown[] { if (!Array.isArray(v)) throw new Error("Expected a list."); return v; }
export const strings = (v: unknown) => array(v).map(string);
export function oneOf<T extends string>(v: unknown, values: readonly T[]): T { if (!values.includes(v as T)) throw new Error(`Unexpected value: ${String(v)}`); return v as T; }
export const dispositions: Disposition[] = ["changed", "clarified-no-change", "reasoned-disagreement", "partially-addressed", "needs-author", "awaiting-figure-approval", "unresolved"];
export function parseInput(v: unknown): ReviewInput {
  const x = object(v); const maxCycles = x.maxCycles;
  if (maxCycles !== 1 && maxCycles !== 2) throw new Error("수정은 최대 두 회차입니다.");
  const documents = strings(x.documents);
  if (!documents.length || new Set(documents).size !== documents.length) throw new Error("서로 다른 원고를 선택해 주세요.");
  const reviewers = array(x.reviewers).map(v => { const r = object(v); return { id: string(r.id), name: string(r.name), focus: string(r.focus), original: string(r.original) }; });
  if (!reviewers.length || reviewers.length > 8 || new Set(reviewers.map(r => r.id)).size !== reviewers.length || reviewers.some(r => !/^R[1-8]$/.test(r.id))) throw new Error("Reviewer ID must be unique (R1–R8).");
  const mode = oneOf(x.mode, ["virtual", "peer"]);
  if (mode === "peer" && reviewers.some(r => !r.original.trim())) throw new Error("각 심사자의 원문 의견을 입력해 주세요.");
  const reviewerModel = string(x.reviewerModel), reviserModel = string(x.reviserModel);
  if (!reviewerModel.trim() || !reviserModel.trim()) throw new Error("GPT와 Claude 모델을 선택해 주세요.");
  return { projectPath: string(x.projectPath), documents, mode, maxCycles, reviewers, reviewerModel, reviserModel,
    decisionLetter: string(x.decisionLetter), language: string(x.language), authorConstraints: string(x.authorConstraints), baselineNote: string(x.baselineNote),
    ...(x.parentSessionId ? { parentSessionId: string(x.parentSessionId) } : {}) };
}
export function parsePlan(v: unknown): RevisionPlan {
  const x = object(v);
  const patches: PatchOperation[] = array(x.patches).map(v => {
    const p = object(v); const base = { id: string(p.id), commentIds: strings(p.commentIds), rationale: string(p.rationale) };
    if (p.kind === "reorder-rows") return { ...base, kind: "reorder-rows", document: string(p.document), blockId: string(p.blockId), beforeHash: string(p.beforeHash), order: array(p.order).map(n => { if (!Number.isInteger(n)) throw new Error("Invalid row index"); return n as number; }) };
    if (p.kind !== "set-text") throw new Error("Unsupported patch operation");
    let calculation;
    if (p.calculation != null) { const c = object(p.calculation); if (!Number.isInteger(c.decimals) || Number(c.decimals) < 0 || Number(c.decimals) > 8) throw new Error("Invalid precision"); calculation = { operation: oneOf(c.operation, ["sum", "percent"]), sourceSlotIds: strings(c.sourceSlotIds), decimals: Number(c.decimals) }; }
    return { ...base, kind: "set-text", slotId: string(p.slotId), before: string(p.before), after: string(p.after), ...(calculation ? { calculation } : {}) };
  });
  return { principles: strings(x.principles), argumentMap: string(x.argumentMap), conflicts: strings(x.conflicts), patches,
    figures: array(x.figures).map(v => { const f = object(v); return { figureId: string(f.figureId), specification: string(f.specification), commentIds: strings(f.commentIds) }; }),
    decisions: array(x.decisions).map(v => { const d = object(v); return { commentId: string(d.commentId), disposition: oneOf(d.disposition, dispositions), reason: string(d.reason) }; }) };
}
export function parseResponses(v: unknown): ResponseItem[] {
  return array(object(v).responses).map(v => { const r = object(v); return { commentId: string(r.commentId), disposition: oneOf(r.disposition, dispositions), response: string(r.response), changeIds: strings(r.changeIds), locations: strings(r.locations), verification: "not-assessed" }; });
}
export function parseAssessment(v: unknown): Assessment {
  const a = object(v);
  if (typeof a.needsRevision !== "boolean" || typeof a.regression !== "boolean") throw new Error("Invalid assessment flags");
  return { needsRevision: a.needsRevision, regression: a.regression, summary: string(a.summary), issues: strings(a.issues),
    comments: array(a.comments).map(v => { const c = object(v); return { commentId: string(c.commentId), verification: oneOf(c.verification, ["verified", "not-verified", "regressed", "not-assessed"]), reason: string(c.reason) }; }) };
}
export function parseModelJSON(text: string): unknown { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")); }
