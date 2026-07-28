import { describe, expect, test } from "bun:test";
import {
  buildBibtexDeduplicationPlan,
  findDuplicateBibtexGroups,
  parseBibtexEntries,
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
