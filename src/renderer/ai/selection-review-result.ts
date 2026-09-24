import { extractDeepenProtectedRevision, type DeepenAnalysisRequest } from "./deepen-analysis";
import { extractValidationResult } from "./validate-analysis";

type ApplyRevision = (requestId: string, revision: string | null) => string | null;
export type SelectionReviewNotice = { kind: "success" | "error"; message: string };

/** Shared completion path: parse the raw response, then apply to the saved selection. */
export function applySelectionReviewResult(
  request: DeepenAnalysisRequest,
  response: string,
  status: "complete" | "error" | "aborted",
  applyRevision?: ApplyRevision,
): SelectionReviewNotice {
  const isValidate = request.mode === "validate";
  const label = isValidate ? "Validate" : "Deepen";
  try {
    if (status !== "complete") {
      throw new Error(`${label} 생성이 완료되지 않아 문서를 변경하지 않았습니다.`);
    }
    const validation = isValidate ? extractValidationResult(response, request.protection) : null;
    const revision = validation
      ? validation.revision
      : extractDeepenProtectedRevision(response, request.protection);
    if (revision === null) {
      applyRevision?.(request.id, null);
      return { kind: "success", message: validation?.verdict === "UNCERTAIN"
        ? "검증 근거가 부족하거나 상충하여 원문을 유지했습니다."
        : "검색 근거 내에서 오류를 발견하지 못해 원문을 유지했습니다." };
    }
    if (!applyRevision) {
      throw new Error("원래 편집 세션을 찾을 수 없어 문서를 변경하지 않았습니다.");
    }
    const error = applyRevision(request.id, revision);
    if (error) return { kind: "error", message: error };
    return { kind: "success", message: isValidate
      ? "검색 근거에 따른 수정안을 선택 영역에 반영했습니다."
      : "통합 개선문을 선택 영역에 반영했습니다." };
  } catch (error) {
    applyRevision?.(request.id, null);
    return { kind: "error", message: error instanceof Error
      ? error.message : `${label} 결과를 안전하게 적용하지 못해 문서를 변경하지 않았습니다.` };
  }
}
