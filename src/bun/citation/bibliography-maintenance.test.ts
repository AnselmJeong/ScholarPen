import { describe, expect, test } from "bun:test";
import type {
  BibliographyEntryValidation,
  BibliographyValidationProgress,
} from "../../shared/rpc-types";
import { cleanValidateAndApplyBibliography } from "./bibliography-maintenance";

const inputBibtex = `@article{used,
  author = {Example, Ada},
  title = {Used paper},
  journal = {Nature Reviews Neuroscience},
  year = {2024}
}

@article{unused,
  author = {Example, Ben},
  title = {Unused paper},
  journal = {Nature Neuroscience},
  year = {2023}
}`;

describe("integrated bibliography maintenance", () => {
  test("removes unused entries and saves verified corrections in the same action", async () => {
    let validatedBibtex = "";
    let savedBibtex = "";
    let savedPrefix = "";
    const progress: BibliographyValidationProgress[] = [];
    const validation: BibliographyEntryValidation = {
      citekey: "used",
      entryType: "article",
      status: "changes",
      fields: [],
      journalAbbreviation: {
        value: "Nat Rev Neurosci",
        source: "nlm-title",
        verified: true,
      },
      suggestedFields: { journal: "Nat Rev Neurosci" },
    };

    const result = await cleanValidateAndApplyBibliography({
      projectPath: "/project",
      bibtex: inputBibtex,
      fileSystem: {
        scanBibliographyUsage: async () => ({
          usedCitekeys: ["used", "missing"],
          scannedDocuments: 2,
        }),
        saveBibliographyMaintenance: async (_projectPath, bibtex, prefix) => {
          savedBibtex = bibtex;
          savedPrefix = prefix;
          return "/project/.scholarpen/backups/bibliography-validation-test";
        },
      },
      onProgress: (item) => progress.push(item),
      validate: async (bibtex) => {
        validatedBibtex = bibtex;
        return {
          validations: [validation],
          suggestedBibtex: bibtex.replace(
            "Nature Reviews Neuroscience",
            "Nat Rev Neurosci",
          ),
        };
      },
    });

    expect(validatedBibtex).toContain("@article{used,");
    expect(validatedBibtex).not.toContain("@article{unused,");
    expect(savedBibtex).toContain("journal = {Nat Rev Neurosci}");
    expect(savedBibtex).not.toContain("@article{unused,");
    expect(savedPrefix).toBe("bibliography-validation");
    expect(result.bibtex).toBe(savedBibtex);
    expect(result.removedUnused).toBe(1);
    expect(result.scannedDocuments).toBe(2);
    expect(result.missingCitekeys).toEqual(["missing"]);
    expect(progress.map((item) => item.stage)).toEqual(["scan", "save"]);
  });
});
