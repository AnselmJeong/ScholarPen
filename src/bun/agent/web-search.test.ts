import { describe, expect, test } from "bun:test";
import {
  academicSourceScore,
  prioritizeAcademicResults,
  type WebSearchResult,
} from "./web-search";

describe("academic web-source priority", () => {
  const results: WebSearchResult[] = [
    {
      title: "자폐 아동 시각 착각 정리",
      url: "https://example.co.kr/blog/autism",
      content: "일반적인 웹 설명",
    },
    {
      title: "Susceptibility to visual illusions in autistic children",
      url: "https://pubmed.ncbi.nlm.nih.gov/12345678/",
      content: "Journal article abstract with DOI 10.1000/example",
    },
    {
      title: "Preprint on contextual integration",
      url: "https://arxiv.org/abs/1234.5678",
      content: "Research article",
    },
  ];

  test("ranks English scholarly sources ahead of Korean general websites", () => {
    const ranked = prioritizeAcademicResults(results);
    expect(ranked[0].url).toContain("pubmed.ncbi.nlm.nih.gov");
    expect(ranked[1].url).toContain("arxiv.org");
    expect(ranked[2].url).toContain("example.co.kr");
  });

  test("assigns a materially higher score to academic databases", () => {
    expect(academicSourceScore(results[1])).toBeGreaterThan(academicSourceScore(results[0]));
  });
});
