import { describe, expect, test } from "bun:test";
import type { AppSettings } from "../../shared/rpc-types";
import {
  proposeBibliographyRepair,
  proposeDeterministicBibliographyRepair,
  validateBibliographyRepair,
} from "./bibliography-repair";

const malformed = `@article{valid,
  title = {Valid entry},
  year = {2020}
}

@article{broken,
  title = {Broken entry},
  year = {2024}
`;

const repaired = `${malformed.trimEnd()}}\n`;

describe("bibliography syntax repair", () => {
  test("proposes the missing closing brace without changing entries", () => {
    expect(proposeDeterministicBibliographyRepair(malformed)).toBe(repaired);
    expect(() => validateBibliographyRepair(malformed, repaired)).not.toThrow();
  });

  test("rejects a syntactically valid proposal that changes metadata", () => {
    expect(() => validateBibliographyRepair(
      malformed,
      repaired.replace("Valid entry", "Invented title"),
    )).toThrow("changed bibliographic metadata");
  });

  test("rejects a proposal that drops an entry", () => {
    expect(() => validateBibliographyRepair(
      malformed,
      `@article{valid, title = {Valid entry}, year = {2020}}`,
    )).toThrow("number of declared BibTeX entries");
  });

  test("validates an LLM proposal before returning it", async () => {
    const settings = {
      sidebarAgentProvider: "openai",
      sidebarAgentModel: "test-model",
    } as AppSettings;
    const proposal = await proposeBibliographyRepair(malformed, "llm", settings, {
      complete: async () => `\`\`\`bibtex\n${repaired.trim()}\n\`\`\``,
    });

    expect(proposal.method).toBe("llm");
    expect(proposal.repairedBibtex).toBe(repaired);
    expect(proposal.model).toBe("test-model");
  });
});
