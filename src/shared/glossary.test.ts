import { expect, test } from "bun:test";
import { checkTerminology, glossaryGuidance, normalizeGlossary } from "./glossary";

const glossary = normalizeGlossary({ entries: [
  { term: "functional magnetic resonance imaging", abbreviation: "fMRI", avoid: ["functional MRI", "f-MRI"] },
  { term: "World Health Organization", abbreviation: "WHO" },
  { term: "electroencephalography", abbreviation: "EEG", noExpansion: true },
  { term: "", abbreviation: "" },
  { term: "functional magnetic resonance imaging", abbreviation: "fMRI" },
] });

test("normalizes entries, dropping empty and duplicate ones", () => {
  expect(glossary.entries.map(entry => entry.abbreviation)).toEqual(["fMRI", "WHO", "EEG"]);
  expect(normalizeGlossary(null)).toEqual({ entries: [] });
  expect(normalizeGlossary({ entries: [{ term: "  a   b ", avoid: ["x", "x", " "] }] }).entries).toEqual([{ term: "a b", avoid: ["x"] }]);
});

test("guidance states preferred forms and avoided variants, and is empty without entries", () => {
  const text = glossaryGuidance(glossary);
  expect(text).toContain("functional magnetic resonance imaging (fMRI)");
  expect(text).toContain("never write: functional MRI / f-MRI");
  expect(glossaryGuidance({ entries: [] })).toBe("");
});

const check = (...texts: string[]) => checkTerminology(texts.map((text, index) => ({ blockId: `p${index + 1}`, text })), glossary);

test("an abbreviation not spelled out at its first use is reported once, with the glossary form", () => {
  const findings = check("We scanned with fMRI and fMRI again.", "Later fMRI data.");
  expect(findings).toEqual([{ blockId: "p1", quote: "fMRI", kind: "abbreviation",
    comment: expect.stringContaining('Write "functional magnetic resonance imaging (fMRI)" here') }]);
});

test("abbreviations introduced in parentheses, common or marked well known are fine", () => {
  expect(check("Functional magnetic resonance imaging (fMRI) is used. Then fMRI.", "Both DNA and EEG and the USA.", "Chapter II and III.")).toEqual([]);
  expect(check("PET (positron emission tomography) scans.")).toEqual([]);
  expect(check("자기공명영상(MRI)을 사용했다. 이후 MRI를 반복했다.")).toEqual([]);
});

test("Korean particles attach to abbreviations; citations and math are not prose", () => {
  expect(check("MRI를 사용했다.")[0]).toMatchObject({ quote: "MRI", kind: "abbreviation" });
  expect(check("As shown [@ABC2020, p. 3] with $X_{AB}$ and @fig-PET.")).toEqual([]);
});

test("avoided variants are reported with the preferred term", () => {
  const findings = check("Functional magnetic resonance imaging (fMRI) is used, unlike functional MRI.");
  expect(findings).toEqual([expect.objectContaining({ kind: "avoid", quote: "functional MRI", comment: 'The project glossary uses "fMRI" instead of "functional MRI".' })]);
});
