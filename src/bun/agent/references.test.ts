import { describe, expect, test } from "bun:test";
import type { SupportingCitation } from "../citation/client";
import { buildCitationReferenceList } from "./references";

describe("verified citation references", () => {
  test("renders the API DOI as a clickable resolver link", () => {
    const citation: SupportingCitation = {
      doi: "10.1186/s13229-017-0127-y",
      citekey: "chouinard2017susceptibility",
      title: "Susceptibility to Ebbinghaus and Müller-Lyer illusions in autistic children",
      authors: ["Chouinard, Philippe"],
      year: 2017,
      journal: "Molecular Autism",
      bibtex: "",
      sourceDatabase: "OpenAlex",
    };

    const references = buildCitationReferenceList([citation]);
    expect(references).toContain("Verified DOI Candidates (1)");
    expect(references).toContain("[C1]");
    expect(references).toContain(
      "[10.1186/s13229-017-0127-y](https://doi.org/10.1186/s13229-017-0127-y)",
    );
    expect(references).toContain("OpenAlex");
  });

  test("marks an empty search as unverified instead of leaving room for invented DOI data", () => {
    const references = buildCitationReferenceList([]);
    expect(references).toContain("Verified DOI Candidates (0)");
    expect(references).toContain("Do not use an unverified citation");
  });
});
