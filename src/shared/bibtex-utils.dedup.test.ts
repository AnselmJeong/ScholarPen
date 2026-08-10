import { describe, expect, test } from "bun:test";
import {
  buildBibtexDeduplicationPlan,
  buildDoiCitationInsertionPlan,
  collectDocumentCitationKeys,
  findDuplicateBibtexGroups,
  parseBibtexEntries,
  removeUnusedBibtexEntries,
  remapDocumentCitationKeys,
} from "./bibtex-utils";

const fristonDuplicates = `@article{friston2010freeenergy,
  author = {Karl Friston},
  title = {The free-energy principle: a unified brain theory?},
  year = {2010},
  doi = {10.1038/nrn2787}
}

@article{friston2010the,
  author = {Friston, Karl},
  title = {The free-energy principle: a unified brain theory?},
  year = {2010}
}`;

describe("bibliography identity deduplication", () => {
  test("groups the same paper even when its citekeys differ", () => {
    const entries = parseBibtexEntries(fristonDuplicates).entries;

    const groups = findDuplicateBibtexGroups(entries);

    expect(groups).toHaveLength(1);
    expect(groups[0].map((entry) => entry.citekey)).toEqual([
      "friston2010freeenergy",
      "friston2010the",
    ]);
  });

  test("keeps the first entry and produces a citekey migration", () => {
    const plan = buildBibtexDeduplicationPlan(fristonDuplicates);

    expect(plan.removedEntries).toBe(1);
    expect(plan.citekeyRemap).toEqual({
      friston2010the: "friston2010freeenergy",
    });
    expect(plan.bibtex).toContain("@article{friston2010freeenergy");
    expect(plan.bibtex).not.toContain("@article{friston2010the");
  });

  test("collapses overlapping citekey and identity matches into one group", () => {
    const source = `@article{keep, author={A}, title={First}, year={2020}}

@article{keep, author={B}, title={Second}, year={2021}}

@article{drop, author={B}, title={Second}, year={2021}}`;
    const groups = findDuplicateBibtexGroups(parseBibtexEntries(source).entries);

    expect(groups).toHaveLength(1);
    expect(groups[0].map((entry) => entry.citekey)).toEqual(["keep", "keep", "drop"]);
  });
});

describe("document citation remapping", () => {
  test("updates structured citation keys while preserving prose and locators", () => {
    const document = [{
      type: "paragraph",
      content: [
        { type: "text", text: "The prose mentions friston2010the literally." },
        {
          type: "citation",
          props: { citekey: "friston2010the", locator: "p. 7" },
        },
      ],
    }];

    const result = remapDocumentCitationKeys(document, {
      friston2010the: "friston2010freeenergy",
    });

    expect(result.replacementCount).toBe(1);
    expect(result.content).toEqual([{
      type: "paragraph",
      content: [
        { type: "text", text: "The prose mentions friston2010the literally." },
        {
          type: "citation",
          props: { citekey: "friston2010freeenergy", locator: "p. 7" },
        },
      ],
    }]);
  });
});

describe("DOI citation insertion", () => {
  const resolved = `@article{friston2010freeenergy,
  author = {Friston, Karl},
  title = {The free-energy principle: a unified brain theory?},
  year = {2010},
  doi = {10.1038/nrn2787}
}`;

  test("requires the resolved BibTeX entry to retain the requested DOI", () => {
    expect(() => buildDoiCitationInsertionPlan(
      "",
      resolved.replace("  doi = {10.1038/nrn2787}\n", ""),
      "10.1038/nrn2787",
    )).toThrow("does not contain the requested DOI");
  });

  test("repairs a matching citekey entry that previously lost its DOI", () => {
    const existing = resolved.replace(",\n  doi = {10.1038/nrn2787}", "");

    const plan = buildDoiCitationInsertionPlan(existing, resolved, "10.1038/nrn2787");

    expect(plan.citekey).toBe("friston2010freeenergy");
    expect(parseBibtexEntries(plan.bibtex).entries).toHaveLength(1);
    expect(parseBibtexEntries(plan.bibtex).entries[0].fields.doi).toBe("10.1038/nrn2787");
  });

  test("uses a new citekey instead of citing an unrelated collision", () => {
    const existing = `@article{friston2010freeenergy,
  author = {Someone, Else},
  title = {A different paper},
  year = {2010}
}`;

    const plan = buildDoiCitationInsertionPlan(existing, resolved, "10.1038/nrn2787");

    expect(plan.citekey).toBe("friston2010freeenergya");
    expect(parseBibtexEntries(plan.bibtex).entries).toHaveLength(2);
  });

  test("reuses the citekey already associated with the DOI", () => {
    const existing = resolved.replace("friston2010freeenergy", "canonicalKey");
    const plan = buildDoiCitationInsertionPlan(existing, resolved, "https://doi.org/10.1038/nrn2787");

    expect(plan).toEqual({ bibtex: existing, citekey: "canonicalKey", changed: false });
  });
});

describe("unused bibliography cleanup", () => {
  test("collects structured citations and removes only unused entries", () => {
    const document = [{
      type: "paragraph",
      content: [
        { type: "citation", props: { citekey: "KeepMe", locator: "p. 3" } },
        { type: "text", text: "dropMe appears only as prose" },
      ],
    }];
    const bibtex = `@article{keepme, title={Keep}, year={2020}}

@article{dropMe, title={Drop}, year={2021}}`;

    const keys = collectDocumentCitationKeys(document);
    const cleanup = removeUnusedBibtexEntries(bibtex, keys);

    expect(cleanup.removedEntries.map((entry) => entry.citekey)).toEqual(["dropMe"]);
    expect(cleanup.bibtex).toContain("@article{keepme");
    expect(cleanup.bibtex).not.toContain("@article{dropMe");
  });
});
