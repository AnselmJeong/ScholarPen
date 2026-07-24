import { describe, expect, test } from "bun:test";
import {
  buildEnglishAcademicFallbackQuery,
  sanitizeEnglishAcademicQuery,
} from "./research-query";

describe("English academic search queries", () => {
  test("normalizes a labeled English scholarly query", () => {
    expect(
      sanitizeEnglishAcademicQuery(
        "English search query: autism Ebbinghaus illusion contextual integration children",
      ),
    ).toBe("autism Ebbinghaus illusion contextual integration children");
  });

  test("rejects a Korean query so external search does not fall back to Korean websites", () => {
    expect(sanitizeEnglishAcademicQuery("자폐 아동의 시각적 착각 연구")).toBe("");
  });

  test("uses embedded English technical terms for a safe academic fallback", () => {
    const query = buildEnglishAcademicFallbackQuery(
      "ASD 아동의 Ebbinghaus illusion과 contextual integration 차이",
    );
    expect(query).toContain("ASD");
    expect(query).toContain("Ebbinghaus");
    expect(query).toContain("contextual");
    expect(query).toContain("peer-reviewed research");
    expect(query).not.toMatch(/[\uAC00-\uD7A3]/u);
  });

  test("does not issue a generic or Korean search when no English term can be recovered", () => {
    expect(buildEnglishAcademicFallbackQuery("자폐 아동의 시각 착각 연구")).toBe("");
  });
});
