import { describe, expect, test } from "bun:test";
import { chunkPdfPages, detectDois, ftsQueryFor, quoteOccursIn, referenceScore } from "./pdf-text";

const sentence = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `The ${topic} finding number ${i} was observed in the trial cohort.`).join(" ");

describe("chunkPdfPages", () => {
  test("marks the start of page 1 as lead, body passages, and the bibliography as refs", () => {
    const pages = [
      { pageNumber: 1, content: `Title of the paper. Abstract: Cathodal tDCS boosted placebo analgesia. ${sentence("intro", 40)}` },
      { pageNumber: 2, content: sentence("methods", 30) },
      { pageNumber: 3, content: sentence("results", 30) },
      { pageNumber: 4, content: `${sentence("discussion", 5)} References 1. Benedetti F, Mayberg HS. Neurobiological mechanisms. J Neurosci. 2005;25:10390–402. 2. Kaptchuk TJ, Miller FG. Placebo effects in medicine. N Engl J Med. 2015;373:8–9.` },
    ];
    const chunks = chunkPdfPages(pages);
    expect(chunks[0].kind).toBe("lead");
    expect(chunks[0].content).toContain("Cathodal tDCS boosted placebo analgesia");
    expect(chunks.some(chunk => chunk.kind === "body" && chunk.page === 3)).toBe(true);
    const refs = chunks.filter(chunk => chunk.kind === "refs");
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every(chunk => chunk.page === 4)).toBe(true);
    expect(chunks.find(chunk => chunk.content.includes("discussion finding number 4"))?.kind).toBe("body");
    expect(chunks.every(chunk => chunk.content.length <= 2_000)).toBe(true);
  });

  test("scores reference lists, not prose with author-year citations", () => {
    expect(referenceScore("Benedetti F, Mayberg HS. J Neurosci. 2005;25:10390. Kaptchuk TJ, Miller FG. N Engl J Med. 2015;373:8. Wager TD, Rilling JK. Science 2004;303(5661):1162. doi:10.1126/science.1093065")).toBeGreaterThanOrEqual(5);
    expect(referenceScore("Placebo effects depend on expectation (Benedetti et al., 2005; Colloca, 2010) and on context.")).toBeLessThan(5);
  });
});

test("detects DOIs printed on the first pages", () => {
  expect(detectDois("https://doi.org/10.1038/s41386-020-0680-x. Received 2020; doi:10.1126/sciadv.abc8845).")).toEqual([
    "10.1038/s41386-020-0680-x", "10.1126/sciadv.abc8845",
  ]);
});

test("finds quotes despite PDF hyphenation, ligature gaps and elisions", () => {
  const source = "These fi ndings suggest that brie fl y educating partici- pants mitigates the large placebo response rates.";
  expect(quoteOccursIn("These findings suggest that briefly educating participants mitigates", source)).toBe(true);
  expect(quoteOccursIn("These findings suggest … the large placebo response rates", source)).toBe(true);
  expect(quoteOccursIn("These findings prove that education eliminates placebo responses", source)).toBe(false);
  expect(quoteOccursIn("short", source)).toBe(false);
});

test("builds a safe FTS query from claims and keywords", () => {
  expect(ftsQueryFor(["tDCS amplifies the placebo effect", "amplify enhance \"boost\" OR NEAR"])).toBe(
    '"tdcs" OR "amplifies" OR "placebo" OR "amplify" OR "enhance" OR "boost" OR "near"',
  );
  expect(ftsQueryFor(["of the and"])).toBeNull();
});
