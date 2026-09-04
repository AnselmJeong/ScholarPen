import { describe, expect, test } from "bun:test";
import type { WebSearchResult } from "./web-search";
import { mergeScholarlyResults } from "./scholarly-search";

function result(
  title: string,
  source: WebSearchResult["source"],
  pmid: string,
  content = title,
): WebSearchResult {
  return {
    title,
    source,
    pmid,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    content,
  };
}

describe("hybrid scholarly search", () => {
  test("boosts results found by both semantic and PubMed retrieval and keeps PubMed metadata", () => {
    const sharedSemantic = result("Shared result", "openalex-semantic", "1", "short");
    const semanticOnly = result("Semantic only", "openalex-semantic", "2");
    const sharedPubMed = result("Shared result", "pubmed", "1", "authoritative PubMed abstract");
    const pubMedOnly = result("PubMed only", "pubmed", "3");

    const merged = mergeScholarlyResults(
      [semanticOnly, sharedSemantic],
      [pubMedOnly, sharedPubMed],
      3,
    );

    expect(merged.map((item) => item.pmid)).toEqual(["1", "2", "3"]);
    expect(merged[0]?.source).toBe("pubmed");
    expect(merged[0]?.content).toBe("authoritative PubMed abstract");
  });
});
