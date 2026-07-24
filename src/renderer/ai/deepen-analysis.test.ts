import { describe, expect, test } from "bun:test";
import {
  buildDeepenAnalysisMessage,
  createDeepenAnalysisRequest,
  isDeepenAnalysisMessage,
} from "./deepen-analysis";

describe("Deepen analysis request", () => {
  test("builds an advisory critique request without embedding the full document", () => {
    const request = createDeepenAnalysisRequest("선택된 핵심 주장", {
      beforeSelection: "문서 앞부분",
      afterSelection: "문서 뒷부분",
    });
    const message = buildDeepenAnalysisMessage(request);

    expect(isDeepenAnalysisMessage(message)).toBe(true);
    expect(message).toContain("선택된 핵심 주장");
    expect(message).toContain("원문에 자동 반영하거나 대치하지 말고");
    expect(message).toContain("비판, 반론");
    expect(message).toContain("비약, 모순");
    expect(message).toContain("## 통합 개선문");
    expect(message).toContain("선택문 전체를 다시 작성");
    expect(message).toContain("원문의 언어");
    expect(message).toContain("원문에 자동 반영되는 대체 작업이 아니라");
    expect(message).not.toContain("문서 앞부분");
    expect(message).not.toContain("문서 뒷부분");
  });

  test("does not classify an ordinary chat message as Deepen", () => {
    expect(isDeepenAnalysisMessage("이 문장을 다듬어 주세요.")).toBe(false);
  });
});
