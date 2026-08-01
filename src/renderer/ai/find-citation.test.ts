import { describe, expect, test } from "bun:test";
import {
  buildFindCitationMessage,
  createFindCitationRequest,
  isFindCitationMessage,
} from "./find-citation";

describe("Find citation request", () => {
  test("requires verified DOI candidates and a clickable DOI link", () => {
    const request = createFindCitationRequest("ASD 아동은 Ebbinghaus 착각의 영향을 덜 받는다.");
    const message = buildFindCitationMessage(request);

    expect(isFindCitationMessage(message)).toBe(true);
    expect(message).toContain(request.selectedText);
    expect(message).toContain("검증된 DOI가 존재하는 후보만");
    expect(message).toContain("https://doi.org/");
    expect(message).toContain("DOI가 확인되지 않은 논문·DOI·링크는 만들거나 추측하지 마세요");
    expect(message).not.toContain("ScholarPen이 제공한");
    expect(message).toContain("최대 5개");
  });

  test("does not classify an ordinary chat message as a citation search", () => {
    expect(isFindCitationMessage("이 문장을 뒷받침할 논문이 있나요?")).toBe(false);
  });
});
