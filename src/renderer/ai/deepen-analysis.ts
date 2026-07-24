import type { InlineEditDocumentContext } from "../components/editor/ai-inline-edit-protection";

export const DEEPEN_ANALYSIS_MARKER = "[ScholarPen Deepen]";

export interface DeepenAnalysisRequest {
  id: string;
  selectedText: string;
  documentContext: InlineEditDocumentContext;
}

export function createDeepenAnalysisRequest(
  selectedText: string,
  documentContext: InlineEditDocumentContext,
): DeepenAnalysisRequest {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    selectedText,
    documentContext,
  };
}

export function buildDeepenAnalysisMessage(request: DeepenAnalysisRequest): string {
  return `${DEEPEN_ANALYSIS_MARKER}

다음 선택문을 원문에 자동 반영하거나 대치하지 말고 심층적으로 검토해 주세요.

각 쟁점을 하나씩 구분하여 다음을 분석해 주세요.
1. 문서 전체의 논지에서 이 선택문이 수행하는 역할과 핵심 주장
2. 사실적으로 부정확하거나 근거가 부족하거나 지나치게 단정적인 부분
3. 가능한 비판, 반론, 누락된 관점
4. 비약, 모순, 개념 혼동, 인과관계 또는 범위의 문제
5. 더 타당한 논증 방식, 대안적 관점, 보완할 근거
6. 더 정확하고 학술적인 표현 예시
7. 중요도순 개선 체크리스트
8. 앞의 타당한 제안을 모두 반영한 선택문 전체의 통합 개선문

각 항목에는 가능한 한 문제되는 원문의 짧은 구절, 문제인 이유, 구체적인 개선 방향을 함께 제시해 주세요. 사실 검증과 해석적 비평을 구분하고, KB 또는 웹에서 확인되지 않은 내용은 확인된 사실처럼 단정하지 마세요.

분석과 체크리스트가 끝난 뒤에는 반드시 \`## 통합 개선문\`이라는 제목으로 선택문 전체를 다시 작성해 주세요. 이 개선문은 앞에서 제시한 타당한 개선 사항을 일관되게 통합하여 사용자가 그대로 활용할 수 있는 완결된 문장 또는 문단이어야 합니다. 원문의 언어, 핵심 의미, 기존 인용, 전문 용어와 불확실성의 정도를 보존하고, 검증되지 않은 사실이나 새로운 인용을 추가하지 마세요. 이는 원문에 자동 반영되는 대체 작업이 아니라 채팅에서 제공하는 최종 수정 제안입니다.

선택문:
${request.selectedText}`;
}

export function isDeepenAnalysisMessage(message: string): boolean {
  return message.trimStart().startsWith(DEEPEN_ANALYSIS_MARKER);
}
