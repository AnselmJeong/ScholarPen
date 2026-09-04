import type {
  InlineEditDocumentContext,
  ProtectedSelection,
} from "../components/editor/ai-inline-edit-protection";

export const DEEPEN_ANALYSIS_MARKER = "[ScholarPen Deepen]";

export interface DeepenAnalysisRequest {
  id: string;
  selectedText: string;
  documentContext: InlineEditDocumentContext;
  protection: ProtectedSelection;
}

export function createDeepenAnalysisRequest(
  selectedText: string,
  documentContext: InlineEditDocumentContext,
  protection: ProtectedSelection,
): DeepenAnalysisRequest {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    selectedText,
    documentContext,
    protection,
  };
}

export function buildDeepenAnalysisMessage(request: DeepenAnalysisRequest): string {
  return `${DEEPEN_ANALYSIS_MARKER}

다음 선택문을 심층적으로 검토하고, 마지막 통합 개선문을 원문의 선택 영역에 안전하게 자동 반영할 수 있도록 작성해 주세요.

각 쟁점을 하나씩 구분하여 다음을 분석해 주세요.
1. 문서 전체의 논지에서 이 선택문이 수행하는 역할과 핵심 주장
2. 사실적으로 부정확하거나 근거가 부족하거나 지나치게 단정적인 부분
3. 가능한 비판, 반론, 누락된 관점
4. 비약, 모순, 개념 혼동, 인과관계 또는 범위의 문제
5. 더 타당한 논증 방식, 대안적 관점, 보완할 근거
6. 더 정확하고 학술적인 표현 예시
7. 중요도순 개선 체크리스트
8. 앞의 타당한 제안을 모두 반영한 선택문 전체의 통합 개선문

각 항목에는 가능한 한 문제되는 원문의 짧은 구절, 문제인 이유, 구체적인 개선 방향을 함께 제시해 주세요. 사실 검증과 해석적 비평을 구분하고, PubMed 또는 웹에서 확인되지 않은 내용은 확인된 사실처럼 단정하지 마세요.

분석과 체크리스트가 끝난 뒤에는 반드시 \`## 통합 개선문\`이라는 제목으로 선택문 전체를 다시 작성해 주세요. 이 개선문은 앞에서 제시한 타당한 개선 사항을 일관되게 통합한 완결된 문장 또는 문단이어야 합니다. 원문의 언어, 핵심 의미, 기존 인용, 전문 용어와 불확실성의 정도를 보존하고, 검증되지 않은 사실이나 새로운 인용을 추가하지 마세요. 시스템이 제공한 ScholarPen 보호 마커를 정확히 유지해야 하며, 이 마지막 개선문은 검증 후 원문의 선택 영역에 자동 반영됩니다.

선택문:
${request.selectedText}`;
}

export function isDeepenAnalysisMessage(message: string): boolean {
  return message.trimStart().startsWith(DEEPEN_ANALYSIS_MARKER);
}

export function extractDeepenProtectedRevision(
  response: string,
  protection: ProtectedSelection,
): string {
  const headingMatches = Array.from(
    response.matchAll(/^#{1,3}[ \t]+(?:\*\*)?(?:통합 개선문|Integrated Revision)(?:\*\*)?[ \t]*:?[ \t]*$/gim),
  );
  const heading = headingMatches.at(-1);
  if (!heading || heading.index === undefined) {
    throw new Error("Deepen 응답에 통합 개선문이 없어 문서를 변경하지 않았습니다.");
  }

  const firstMarker = protection.markers[0];
  const lastMarker = protection.markers.at(-1);
  if (!firstMarker || !lastMarker) {
    throw new Error("보호된 선택 영역 정보가 없어 문서를 변경하지 않았습니다.");
  }

  const section = response.slice(heading.index + heading[0].length);
  const start = section.indexOf(firstMarker.token);
  const lastStart = section.lastIndexOf(lastMarker.token);
  if (start < 0 || lastStart < start) {
    throw new Error("Deepen 통합 개선문의 보호 마커가 불완전하여 문서를 변경하지 않았습니다.");
  }

  return section.slice(start, lastStart + lastMarker.token.length);
}

export function formatDeepenAnalysisForDisplay(
  response: string,
  protection: ProtectedSelection,
): string {
  let display = response;
  for (const marker of protection.markers) {
    const replacement = marker.kind === "literal"
      ? marker.value
      : marker.kind === "node"
        ? marker.preview
        : "";
    display = display.split(marker.token).join(replacement);
  }

  // Hide an as-yet incomplete control marker while the response is streaming,
  // and never expose an unexpected marker in the rendered chat transcript.
  return display.replace(/⟦SP:[^⟧]*(?:⟧|$)/g, "").trimEnd();
}
