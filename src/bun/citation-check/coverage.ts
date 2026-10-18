import type { CitationSourcesStatus } from "../../shared/rpc-types";
import { parseBibtexEntries } from "../../shared/bibtex-utils";
import { fileSystem } from "../fs/manager";
import { cleanDoi } from "./pdf-text";
import { getCitationSourceIndex } from "./source-index";

/** How many works cited in the project's documents have an indexed PDF, and which do not. */
export async function citationPdfCoverage(projectPath: string): Promise<NonNullable<CitationSourcesStatus["coverage"]>> {
  const [{ usedCitekeys }, bibtex] = await Promise.all([
    fileSystem.scanBibliographyUsage(projectPath),
    fileSystem.loadBibtex(projectPath),
  ]);
  const used = new Set(usedCitekeys);
  const entries = parseBibtexEntries(bibtex).entries;
  const cited = entries.filter(entry => used.has(entry.citekey));
  const links = await getCitationSourceIndex(projectPath).linkEntries(entries, used);
  const missing = cited
    .filter(entry => links.get(entry.citekey)?.status !== "indexed")
    .map(entry => ({
      citekey: entry.citekey,
      title: (entry.fields.title ?? "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim(),
      doi: cleanDoi(entry.fields.doi ?? "") || null,
    }));
  return { citedCount: cited.length, linkedCount: cited.length - missing.length, missing };
}
