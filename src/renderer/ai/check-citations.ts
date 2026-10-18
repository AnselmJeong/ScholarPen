import {
  protectedRewritePreview,
  type InlineEditDocumentContext,
  type ProtectedSelection,
} from "../components/editor/ai-inline-edit-protection";

export const CHECK_CITATIONS_MARKER = "[ScholarPen Check Citations]";

export interface CitationCheckRequest {
  id: string;
  /** The selection with its citations shown as [@key]. */
  selectedText: string;
  protection: ProtectedSelection;
  documentContext: InlineEditDocumentContext;
}

/** Citation nodes, or literal [@key] text, in the selection. */
export function selectionHasCitations(protection: ProtectedSelection): boolean {
  return protection.markers.some(marker =>
    (marker.kind === "node" && marker.nodeType === "citation") ||
    (marker.kind === "literal" && marker.value.startsWith("[@")));
}

export function createCitationCheckRequest(
  protection: ProtectedSelection,
  documentContext: InlineEditDocumentContext,
): CitationCheckRequest {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    selectedText: protectedRewritePreview(protection.protectedText, protection),
    protection,
    documentContext,
  };
}

export function buildCitationCheckMessage(request: CitationCheckRequest): string {
  return `${CHECK_CITATIONS_MARKER}

선택문에 인용된 문헌이 실제로 그 문장을 뒷받침하는지 확인해 주세요. resources/의 원문 PDF가 있으면 원문을, 없으면 OpenAlex 초록을 근거로 판단하고, 오류로 보는 이유와 개선안을 함께 제시해 주세요.

선택문:
${request.selectedText}`;
}
