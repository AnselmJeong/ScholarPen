export const FIND_CITATION_MARKER = "[ScholarPen Find Citation]";

export interface FindCitationRequest {
  id: string;
  selectedText: string;
  beforeSelection?: string;
  afterSelection?: string;
  claims?: string[];
}

export function createFindCitationRequest(
  selectedText: string,
  context?: { beforeSelection: string; afterSelection: string },
  claims?: string[],
): FindCitationRequest {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    selectedText,
    beforeSelection: context?.beforeSelection.slice(-1_000),
    afterSelection: context?.afterSelection.slice(0, 1_000),
    claims,
  };
}

export function buildFindCitationMessage(request: FindCitationRequest): string {
  return `${FIND_CITATION_MARKER}

선택문의 주장을 정리하여 지지·반박 근거와 정확한 학술 인용을 찾아 주세요.
DOI·논문·링크를 만들거나 추측하지 마세요. 근거가 부족하면 한계를 표시해 주세요.
${request.claims?.length ? `\n수정한 검색 주장:\n${request.claims.join("\n")}\n` : ""}

선택문:
${request.selectedText}`;
}

export function isFindCitationMessage(message: string): boolean {
  return message.trimStart().startsWith(FIND_CITATION_MARKER);
}
