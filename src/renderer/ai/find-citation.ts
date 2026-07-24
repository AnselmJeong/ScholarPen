export const FIND_CITATION_MARKER = "[ScholarPen Find Citation]";

export interface FindCitationRequest {
  id: string;
  selectedText: string;
}

export function createFindCitationRequest(selectedText: string): FindCitationRequest {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    selectedText,
  };
}

export function buildFindCitationMessage(request: FindCitationRequest): string {
  return `${FIND_CITATION_MARKER}

다음 선택문의 핵심 주장을 직접 뒷받침하는 정확한 학술 인용을 찾아 주세요.

반드시 ScholarPen이 제공한 검증된 DOI 후보만 사용하고, 후보에 없는 논문·DOI·링크는 만들거나 추측하지 마세요. 각 결과에는 다음을 포함해 주세요.
1. 완전한 서지정보
2. 선택문의 어떤 주장과 맞는지에 대한 구체적인 설명
3. 초록이 없거나 직접적인 근거가 약할 때의 명확한 한계
4. 정확한 DOI 문자열과 클릭 가능한 https://doi.org/ 링크

가장 직접적으로 뒷받침하는 후보부터 최대 5개를 보여 주세요. 적합한 후보가 없다면 수를 채우지 말고, 정확한 인용을 찾지 못했다고 분명히 말해 주세요.

선택문:
${request.selectedText}`;
}

export function isFindCitationMessage(message: string): boolean {
  return message.trimStart().startsWith(FIND_CITATION_MARKER);
}
