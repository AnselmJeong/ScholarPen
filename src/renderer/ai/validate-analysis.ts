import type { ProtectedSelection } from "../components/editor/ai-inline-edit-protection";
import { extractDeepenProtectedRevision } from "./deepen-analysis";

export type ValidationResult =
  | { verdict: "CORRECTED"; revision: string }
  | { verdict: "UNCHANGED" | "UNCERTAIN"; revision: null };

/** Fail closed: an explanation or a partial stream is never a replacement. */
export function extractValidationResult(
  response: string,
  protection: ProtectedSelection,
): ValidationResult {
  const verdicts = Array.from(response.matchAll(
    /^## Validation verdict[ \t]*\r?\n[ \t]*(CORRECTED|UNCHANGED|UNCERTAIN)[ \t]*\r?$/gm,
  ));
  if (verdicts.length !== 1) {
    throw new Error("Validate 판정을 확인할 수 없어 원문을 유지했습니다.");
  }
  const verdict = verdicts[0][1] as ValidationResult["verdict"];
  if (verdict !== "CORRECTED") return { verdict, revision: null };

  // Require a source citation in the findings, not only in the appended source list.
  const findings = response.slice(0, verdicts[0].index);
  if (!/\[W[1-9]\d*\]/.test(findings)) {
    throw new Error("수정 근거의 출처가 없어 원문을 유지했습니다.");
  }
  const revision = extractDeepenProtectedRevision(
    response.slice(verdicts[0].index), protection, "Validate",
  );
  return { verdict, revision };
}
