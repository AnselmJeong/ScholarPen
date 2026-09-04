import { describe, expect, test } from "bun:test";
import { broadenPubMedQuery, parsePubMedXml, searchPubMed } from "./pubmed-search";
import type { FetchLike } from "./web-search";

describe("parsePubMedXml", () => {
  test("broadens an over-constrained academic query for PubMed retry", () => {
    expect(broadenPubMedQuery("placebo effect interoception systematic review"))
      .toBe("placebo effect interoception");
  });

  test("extracts PubMed metadata and a structured abstract", () => {
    const xml = `<PubmedArticleSet>
      <PubmedArticle>
        <MedlineCitation>
          <PMID>12345678</PMID>
          <Article>
            <Journal><JournalIssue><PubDate><Year>2025</Year></PubDate></JournalIssue><Title>Journal of Tests</Title></Journal>
            <ArticleTitle>Effects of &lt;i&gt;testing&lt;/i&gt; on evidence</ArticleTitle>
            <Abstract>
              <AbstractText Label="BACKGROUND">Prior evidence was mixed.</AbstractText>
              <AbstractText Label="RESULTS">Testing improved outcomes.</AbstractText>
            </Abstract>
            <AuthorList><Author><LastName>Kim</LastName><ForeName>Min</ForeName></Author></AuthorList>
            <ELocationID EIdType="doi">10.1000/test.1</ELocationID>
          </Article>
        </MedlineCitation>
      </PubmedArticle>
    </PubmedArticleSet>`;

    expect(parsePubMedXml(xml)).toEqual([{
      title: "Effects of testing on evidence",
      url: "https://pubmed.ncbi.nlm.nih.gov/12345678/",
      content: expect.stringContaining("RESULTS: Testing improved outcomes."),
      source: "pubmed",
      pmid: "12345678",
      doi: "10.1000/test.1",
    }]);
    expect(parsePubMedXml(xml)[0]?.content).toContain("DOI: 10.1000/test.1");
    expect(parsePubMedXml(xml)[0]?.content).toContain("Kim, Min. 2025. Journal of Tests");
  });

  test("sends the configured NCBI API key to both ESearch and EFetch", async () => {
    const requestedUrls: string[] = [];
    const fetchFn: FetchLike = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/esearch.fcgi")) {
        return Response.json({ esearchresult: { idlist: ["12345678"] } });
      }
      return new Response(`<PubmedArticleSet>
        <PubmedArticle>
          <MedlineCitation>
            <PMID>12345678</PMID>
            <Article><ArticleTitle>Verified PubMed result</ArticleTitle></Article>
          </MedlineCitation>
        </PubmedArticle>
      </PubmedArticleSet>`);
    };

    const results = await searchPubMed("placebo", 5, {
      apiKey: " ncbi-secret ",
      fetchFn,
    });

    expect(results).toHaveLength(1);
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls.every((url) => new URL(url).searchParams.get("api_key") === "ncbi-secret"))
      .toBeTrue();
  });

  test("omits the NCBI API key parameter when the setting is blank", async () => {
    let requestedUrl = "";
    const fetchFn: FetchLike = async (input) => {
      requestedUrl = String(input);
      return Response.json({ esearchresult: { idlist: [] } });
    };

    await searchPubMed("placebo", 5, { apiKey: "   ", fetchFn });

    expect(new URL(requestedUrl).searchParams.has("api_key")).toBeFalse();
  });
});
