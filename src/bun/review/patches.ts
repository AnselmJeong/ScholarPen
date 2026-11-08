import type { AppliedChange, PatchOperation, ReviewContext, ReviewComment, ResponseItem, AuthorCheck } from "../../shared/review-session/types";
import { atPath, setPath, describeDocument } from "./context";
import { hash, writeJSON } from "./workspace";
import { object } from "../../shared/review-session/schema";
const numbers = (text: string) => text.match(/[-+]?\d+(?:[.,]\d+)*(?:[eE][-+]?\d+)?/g) ?? [];
export function validateCommentIds(ids: string[], comments: ReviewComment[]) {
  if (!ids.length || ids.some(id => !comments.some(c => c.id === id))) throw new Error("Change refers to an unknown comment");
}
export function applyPatches(input: ReviewContext, patches: PatchOperation[], comments: ReviewComment[], round: number, options: { deferUnverified?: boolean } = {}) {
  const authorChecks: AuthorCheck[] = [];
  const documents = structuredClone(input.documents); const changes: AppliedChange[] = []; const touched = new Set<string>();
  for (const p of patches) {
    validateCommentIds(p.commentIds, comments);
    try {
    if (!p.id.trim() || !p.rationale.trim()) throw new Error("Patch ID and evidence are required");
    if (p.kind === "set-text") {
      const slot = input.slots.find(s => s.id === p.slotId); if (!slot || touched.has(slot.id)) throw new Error("Unknown or repeated text slot"); touched.add(slot.id);
      if (slot.text !== p.before || atPath(documents[slot.document], slot.path) !== p.before) throw new Error("Patch baseline mismatch");
      if (p.before === p.after) throw new Error("No-op patch cannot support a changed response");
      if (JSON.stringify(numbers(p.before)) !== JSON.stringify(numbers(p.after))) {
        if (slot.kind !== "table" || !p.calculation) throw new Error(`수치 변경에 확인 가능한 계산 근거가 없습니다 (${numbers(p.before).join(", ") || "없음"} → ${numbers(p.after).join(", ") || "없음"}). 용어 설명에 추가된 숫자도 포함됩니다.`);
        const values = p.calculation.sourceSlotIds.map(id => {
          const source = input.slots.find(s => s.id === id);
          if (!source || source.kind !== "table" || !/^[-+]?\d+(?:\.\d+)?$/.test(source.text.trim())) throw new Error("Calculation requires explicit numeric table source cells"); return Number(source.text);
        });
        if (!values.length) throw new Error("Missing calculation inputs");
        let result: number;
        if (p.calculation.operation === "percent") { if (values.length !== 2 || values[1] === 0) throw new Error("Invalid denominator"); result = values[0]! / values[1]! * 100; }
        else result = values.reduce((a, b) => a + b, 0);
        const expected = result.toFixed(p.calculation.decimals) + (p.after.trim().endsWith("%") ? "%" : "");
        if (!Number.isFinite(result) || p.after.trim() !== expected) throw new Error("Proposed value does not match the reproducible calculation");
      }
      if (/\[@|@(?:fig|tbl|eq)-|<script|javascript:/i.test(p.after) && !/\[@|@(?:fig|tbl|eq)-|<script|javascript:/i.test(p.before)) throw new Error("New references require verified structured evidence; leave this request unresolved.");
      setPath(documents[slot.document], slot.path, p.after);
      changes.push({ id: `C${round}-${p.id}`, target: slot.id, before: p.before, after: p.after, commentIds: p.commentIds, rationale: p.rationale });
    } else {
      if (input.coverage.some(c => c.target === p.document && c.status === "unavailable")) throw new Error("Document structure is read-only; author review required");
      if (patches.some(other => other.kind === "set-text" && input.slots.some(s => s.id === other.slotId && s.document === p.document && s.blockId === p.blockId))) throw new Error("Reorder and cell changes must use separate candidates");
      let table: Record<string, unknown> | undefined;
      const walk = (items: unknown[]) => { for (const item of items) { const b = object(item); if (b.id === p.blockId && b.type === "table") table = b; if (Array.isArray(b.children)) walk(b.children); } };
      if (!documents[p.document]) throw new Error("Unknown document"); walk(documents[p.document]!);
      if (!table) throw new Error("Unknown table"); const content = object(table.content); const rows = content.rows as unknown[];
      if (hash(JSON.stringify(rows)) !== p.beforeHash || p.order.length !== rows.length || new Set(p.order).size !== rows.length || p.order.some(i => i < 0 || i >= rows.length) || p.order[0] !== 0) throw new Error("Invalid table reorder (header must remain first)");
      const before = JSON.stringify(rows); content.rows = p.order.map(i => rows[i]);
      changes.push({ id: `C${round}-${p.id}`, target: `${p.document}#${p.blockId}`, before, after: JSON.stringify(content.rows), commentIds: p.commentIds, rationale: p.rationale });
    }
    } catch (error) {
      if (!options.deferUnverified) throw error;
      const slot = p.kind === "set-text" ? input.slots.find(s => s.id === p.slotId) : undefined;
      authorChecks.push({ id: `A${round}-${p.id}`, target: p.kind === "set-text" ? p.slotId : `${p.document}#${p.blockId}`,
        before: slot ? String(atPath(documents[slot.document], slot.path)) : "원고 위치 또는 기준 내용을 확인할 수 없음",
        proposed: p.kind === "set-text" ? p.after : JSON.stringify(p.order), commentIds: p.commentIds,
        rationale: p.rationale, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const [name, blocks] of Object.entries(documents)) if (JSON.stringify(blocks) !== JSON.stringify(input.documents[name])) describeDocument(name, blocks);
  return { documents, changes, authorChecks };
}
export async function savePatchedDocuments(root: string, documents: Record<string, unknown[]>) {
  for (const [name, blocks] of Object.entries(documents)) await writeJSON(root, `documents/${name}`, blocks);
}
export function validateResponses(responses: ResponseItem[], comments: ReviewComment[], changes: AppliedChange[]) {
  if (responses.length !== comments.length || new Set(responses.map(r => r.commentId)).size !== comments.length) throw new Error("Every original comment requires exactly one complete response");
  for (const r of responses) {
    validateCommentIds([r.commentId], comments);
    if (!r.response.trim()) throw new Error("Empty response");
    if (r.changeIds.some(id => !changes.some(c => c.id === id && c.commentIds.includes(r.commentId)))) throw new Error("Response cites a change that was not applied to this comment");
    if (r.disposition === "changed" && !r.changeIds.length) throw new Error("Changed response has no applied evidence");
    if (["clarified-no-change", "reasoned-disagreement"].includes(r.disposition) && !r.locations.length) throw new Error("No-change response needs manuscript locations or quoted evidence");
  }
}

/** Keep only changes still present relative to the original baseline. */
export function cumulativeChanges(previous: AppliedChange[], fresh: AppliedChange[]): AppliedChange[] {
  const byTarget = new Map(previous.map(c => [c.target, { ...c }]));
  for (const change of fresh) {
    const earlier = byTarget.get(change.target);
    const merged = earlier ? { ...change, before: earlier.before, commentIds: [...new Set([...earlier.commentIds, ...change.commentIds])] } : change;
    if (merged.before === merged.after) byTarget.delete(change.target); else byTarget.set(change.target, merged);
  }
  return [...byTarget.values()];
}
