import { describe, expect, test } from "bun:test";
import {
  buildBibtexAppendPlan,
  buildDoiResolverUrl,
  parseBibtexEntries,
  partitionBibtexAdditions,
} from "./bibtex-utils";

describe("bibliography integrity", () => {
  test("builds only HTTPS DOI resolver links from valid bibliography values", () => {
    expect(buildDoiResolverUrl("https://doi.org/10.1038/NRN2787")).toBe(
      "https://doi.org/10.1038/nrn2787",
    );
    expect(buildDoiResolverUrl("doi:10.1000/article?part=1")).toBe(
      "https://doi.org/10.1000/article%3Fpart%3D1",
    );
    expect(buildDoiResolverUrl("javascript:alert(1)")).toBeNull();
    expect(buildDoiResolverUrl(undefined)).toBeNull();
  });

  test("refuses to append into an already malformed bibliography", () => {
    const malformed = `@article{broken, title={Missing closing brace}`;
    const addition = `@article{newEntry, title={New entry}, year={2025}}`;

    expect(() => buildBibtexAppendPlan(malformed, addition)).toThrow(
      "Existing BibTeX is invalid at line 1, column 1",
    );
  });

  test("keeps the appended entry independently parseable", () => {
    const current = `@article{existing, title={Existing}, year={2020}}`;
    const addition = `@article{newEntry, title={New entry}, year={2025}}`;
    const plan = buildBibtexAppendPlan(current, addition);

    expect(parseBibtexEntries(plan.bibtex).entries.map((entry) => entry.citekey)).toEqual([
      "existing",
      "newEntry",
    ]);
  });

  test("reports line, column, entry hint, and source context for syntax errors", () => {
    const malformed = `@article{valid, title={Valid}}\n\n@book{broken, title={Broken}`;
    const issue = parseBibtexEntries(malformed).issues[0];

    expect(issue.line).toBe(3);
    expect(issue.column).toBe(1);
    expect(issue.entryHint).toBe("@book{broken}");
    expect(issue.context).toContain("3: @book{broken");
  });

  test("partitions bulk additions so duplicates are skipped without rejecting new entries", () => {
    const existing = parseBibtexEntries(`@article{burke2019differential,
  author={Burke, Michael},
  title={Differential effects},
  year={2019},
  doi={10.1000/existing}
}`).entries;
    const candidates = parseBibtexEntries(`@article{samePaperDifferentKey,
  author={Burke, Michael},
  title={Differential effects},
  year={2019},
  doi={10.1000/existing}
}

@article{newPaper,
  author={Smith, Jane},
  title={A genuinely new paper},
  year={2025},
  doi={10.1000/new}
}

@article{newPaperDuplicate,
  author={Smith, Jane},
  title={A genuinely new paper},
  year={2025},
  doi={10.1000/new}
}`).entries;

    const partition = partitionBibtexAdditions(existing, candidates);
    expect(partition.accepted.map((entry) => entry.citekey)).toEqual(["newPaper"]);
    expect(partition.skipped.map(({ entry, duplicateOf }) => [entry.citekey, duplicateOf.citekey]))
      .toEqual([
        ["samePaperDifferentKey", "burke2019differential"],
        ["newPaperDuplicate", "newPaper"],
      ]);
  });
});
