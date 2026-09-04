import { describe, expect, test } from "bun:test";
import { broadenPubMedQuery, parsePubMedXml } from "./pubmed-search";

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
    }]);
    expect(parsePubMedXml(xml)[0]?.content).toContain("DOI: 10.1000/test.1");
    expect(parsePubMedXml(xml)[0]?.content).toContain("Kim, Min. 2025. Journal of Tests");
  });
});
