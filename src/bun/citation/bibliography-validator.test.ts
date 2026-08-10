import { describe, expect, test } from "bun:test";
import { parseBibtexEntries } from "../../shared/bibtex-utils";
import {
  buildEntryValidation,
  isStrongCrossrefCandidate,
  normalizeBibliographicText,
  scoreCrossrefCandidate,
  type CrossrefValidationWork,
} from "./bibliography-validator";

const entry = parseBibtexEntries(`@article{friston2010freeenergy,
  author = {Friston, Karl},
  title = {The free-energy principle: a unified brain theory?},
  journal = {Nature Reviews Neuroscience},
  year = {2010},
  volume = {10},
  pages = {127--130}
}`).entries[0];

const work: CrossrefValidationWork = {
  DOI: "10.1038/nrn2787",
  type: "journal-article",
  title: ["The free-energy principle: a unified brain theory?"],
  author: [{ family: "Friston", given: "Karl" }],
  published: { "date-parts": [[2010, 1, 13]] },
  "container-title": ["Nature Reviews Neuroscience"],
  "short-container-title": ["Nat Rev Neurosci"],
  volume: "11",
  issue: "2",
  page: "127-138",
  ISSN: ["1471-003X"],
};

describe("Crossref bibliography matching", () => {
  test("normalizes BibTeX protection and punctuation", () => {
    expect(normalizeBibliographicText("The {B}ayesian-brain?"))
      .toBe("the bayesian brain");
  });

  test("accepts an exact title-author-year candidate conservatively", () => {
    expect(scoreCrossrefCandidate(entry, work)).toBeGreaterThan(0.95);
    expect(isStrongCrossrefCandidate(entry, work)).toBe(true);
  });

  test("rejects a different first author even when the title is the same", () => {
    expect(isStrongCrossrefCandidate(entry, {
      ...work,
      author: [{ family: "Someone", given: "Else" }],
    })).toBe(false);
  });
});

describe("bibliography validation suggestions", () => {
  test("suggests DOI, volume, issue, pages, and an NLM-verified abbreviation", () => {
    const validation = buildEntryValidation(
      { entry, work, matchMethod: "bibliographic", confidence: 1 },
      new Map([["1471-003x", { title: "Nat Rev Neurosci" }]]),
    );

    expect(validation.status).toBe("changes");
    expect(validation.journalAbbreviation).toEqual({
      value: "Nat Rev Neurosci",
      source: "nlm-title",
      verified: true,
    });
    expect(validation.suggestedFields).toEqual({
      doi: "10.1038/nrn2787",
      volume: "11",
      number: "2",
      pages: "127--138",
      journal: "Nat Rev Neurosci",
    });
  });

  test("does not auto-correct metadata when DOI identity conflicts", () => {
    const validation = buildEntryValidation({
      entry,
      work: { ...work, title: ["A different paper"] },
      matchMethod: "doi",
      confidence: 1,
    });

    expect(validation.status).toBe("changes");
    expect(validation.suggestedFields).toBeUndefined();
    expect(validation.message).toContain("does not match");
  });
});
