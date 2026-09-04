import { describe, expect, test } from "bun:test";
import {
  parseOpenAlexSemanticResults,
  searchOpenAlexSemantic,
} from "./openalex-semantic-search";
import type { FetchLike } from "./web-search";

const semanticPayload = {
  results: [{
    id: "https://openalex.org/W1",
    title: "Placebo mechanisms in neuromodulation",
    doi: "https://doi.org/10.1000/example",
    ids: { pmid: "https://pubmed.ncbi.nlm.nih.gov/12345678" },
    publication_year: 2025,
    relevance_score: 0.98,
    abstract_inverted_index: {
      Placebo: [0],
      mechanisms: [1],
      matter: [2],
    },
    authorships: [{ author: { display_name: "Anselm Jeong" } }],
    primary_location: { source: { display_name: "Journal of Testing" } },
  }],
};

describe("OpenAlex semantic scholarly search", () => {
  test("maps semantic results to citable scholarly context", () => {
    expect(parseOpenAlexSemanticResults(semanticPayload)).toEqual([{
      title: "Placebo mechanisms in neuromodulation",
      url: "https://pubmed.ncbi.nlm.nih.gov/12345678/",
      content: expect.stringContaining("Abstract: Placebo mechanisms matter"),
      source: "openalex-semantic",
      pmid: "12345678",
      doi: "10.1000/example",
      relevanceScore: 0.98,
    }]);
  });

  test("calls the verified semantic endpoint and authenticates without exposing the key in the URL", async () => {
    let requestedUrl = "";
    let requestedHeaders = new Headers();
    const fetchFn: FetchLike = async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      return Response.json(semanticPayload);
    };

    const results = await searchOpenAlexSemantic(
      "placebo effects in neuromodulation",
      5,
      "secret-key",
      undefined,
      fetchFn,
    );

    const url = new URL(requestedUrl);
    expect(url.origin + url.pathname).toBe("https://api.openalex.org/works");
    expect(url.searchParams.get("search.semantic")).toBe("placebo effects in neuromodulation");
    expect(url.searchParams.get("per-page")).toBe("5");
    expect(url.searchParams.has("api_key")).toBeFalse();
    expect(requestedHeaders.get("Authorization")).toBe("Bearer secret-key");
    expect(results).toHaveLength(1);
  });
});
