import { describe, expect, test } from "bun:test";
import {
  buildFindCitationMessage,
  createFindCitationRequest,
  isFindCitationMessage,
} from "./find-citation";

describe("Find citation request", () => {
  test("requests evidence for both sides without inventing citations", () => {
    const request = createFindCitationRequest("ASD 아동은 Ebbinghaus 착각의 영향을 덜 받는다.");
    const message = buildFindCitationMessage(request);

    expect(isFindCitationMessage(message)).toBe(true);
    expect(message).toContain(request.selectedText);
    expect(message).toContain("지지·반박 근거");
    expect(message).toContain("DOI·논문·링크를 만들거나 추측하지 마세요");
    expect(message).not.toContain("ScholarPen이 제공한");
  });

  test("carries bounded surrounding context and explicit user-edited claims", () => {
    const request = createFindCitationRequest("selected", { beforeSelection: "a".repeat(2_000), afterSelection: "b".repeat(2_000) }, ["An edited claim."]);
    expect(request.beforeSelection).toHaveLength(1_000);
    expect(request.afterSelection).toHaveLength(1_000);
    expect(buildFindCitationMessage(request)).toContain("An edited claim.");
    expect(buildFindCitationMessage(request)).not.toContain("a".repeat(1_000));
  });

  test("does not classify an ordinary chat message as a citation search", () => {
    expect(isFindCitationMessage("이 문장을 뒷받침할 논문이 있나요?")).toBe(false);
  });
});
