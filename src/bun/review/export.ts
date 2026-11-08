import { join } from "node:path";
import { mkdir, rename } from "node:fs/promises";
import type { ReviewSession, RoundResult } from "../../shared/review-session/types";
import { atomicWrite, copyPackage, manifest, writeJSON, exists, scopedPath } from "./workspace";
export function warningMarkdown(s: ReviewSession) {
  if (!s.warnings?.length) return "";
  const ko = /korean|한국|한글/i.test(s.input.language);
  return `\n\n## ${ko ? "자동 검토의 한계 — 저자 확인 필요" : "Automated review limitations — author confirmation required"}\n\n${ko ? "일부 자동 검토를 완료하지 못했습니다. 아래 단계의 결과를 검증된 것으로 간주하지 마세요." : "Some automated stages could not be completed. Do not treat those stages as verified."}\n\n` + s.warnings.map(w => `- ${w.stage}: ${w.reason}`).join("\n");
}
export function responseMarkdown(s: ReviewSession, round: RoundResult) {
  return `# Response to the Editor and Reviewers\n\n${s.input.mode === "virtual" ? "Virtual review simulation — not external peer review.\n\n" : ""}` + s.comments.map(c => {
    const r = round.responses.find(r => r.commentId === c.id)!;
    return `## ${c.reviewerId} · ${c.id}\n\n${c.original.split("\n").map(line => `> ${line}`).join("\n")}\n\n${r.response}\n\nLocation: ${r.locations.join("; ") || "No manuscript change"}\n`;
  }).join("\n") + warningMarkdown(s);
}
export async function finalize(root: string, s: ReviewSession) {
  const latest = s.rounds.at(-1); if (!latest) throw new Error("No completed candidate exists");
  const chosen = latest.assessment.regression && s.rounds.length > 1 ? s.rounds[s.rounds.length - 2]! : latest;
  s.selectedFinalRound = chosen.round;
  const open = chosen.responses.filter(r => r.verification !== "verified" || ["needs-author", "awaiting-figure-approval", "unresolved", "partially-addressed"].includes(r.disposition));
  const incomplete = chosen.coverage.some(c => c.status === "unavailable") || s.manifest.warnings.length > 0;
  s.quality = incomplete ? "incomplete-coverage" : open.length || s.warnings?.length || chosen.assessment.issues.length || chosen.assessment.regression || latest.assessment.regression ? "needs-author-action" : "ready-for-author-review";
  const folder = ".state/final-candidate"; const temp = await scopedPath(root, folder);
  if (!await exists(root, "final/package-manifest.json")) {
    await mkdir(temp, { recursive: true });
    await copyPackage(join(root, `rounds/${String(chosen.round).padStart(2, "0")}/project`), join(temp, "project"));
    await atomicWrite(temp, "response-to-reviewers.md", responseMarkdown(s, chosen));
    await writeJSON(temp, "response.json", { schemaVersion: 1, responses: chosen.responses });
    await writeJSON(temp, "review-warnings.json", { schemaVersion: 1, warnings: s.warnings ?? [] });
    await writeJSON(temp, "author-checks.json", { schemaVersion: 1, checks: chosen.authorChecks ?? [] });
    await atomicWrite(temp, "change-summary.md", "# Changes from baseline\n\n" + chosen.changes.map(c => `## ${c.id} · ${c.target}\n\nBefore:\n\n${c.before}\n\nAfter:\n\n${c.after}\n\nEvidence: ${c.rationale}\n`).join("\n"));
    await atomicWrite(temp, "unresolved-issues.md", "# Author actions\n\n" + open.map(r => `- ${r.commentId}: ${r.disposition}; ${r.verification}\n\n${r.response}`).join("\n\n") + "\n\n" + chosen.assessment.issues.join("\n\n") + warningMarkdown(s));
    await atomicWrite(temp, "quality-report.md", `# Internal review report\n\nQuality: ${s.quality}\nSelected round: ${chosen.round}\n\n${chosen.assessment.summary}\n\n${chosen !== latest ? `Later round rejected for regression: ${latest.assessment.summary}\n${latest.assessment.issues.join("\n")}` : ""}\n\nThis is an internal assessment, not journal acceptance or a submission guarantee.\n\n## Coverage\n\n` + chosen.coverage.map(c => `- ${c.target}: ${c.status} — ${c.detail}`).join("\n") + "\n\n" + s.manifest.warnings.join("\n") + "\n\n## Deterministic checks\n\n" + chosen.validation.join("\n") + warningMarkdown(s));
    await writeJSON(temp, "package-manifest.json", { ...await manifest(temp), selectedFinalRound: chosen.round, quality: s.quality });
    await rename(temp, await scopedPath(root, "final"));
  }
}
