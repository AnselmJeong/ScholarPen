import type { WebSearchResult } from "./web-search";
import type { SupportingCitation } from "../citation/client";

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_[\]])/g, "\\$1").replace(/\s+/g, " ").trim();
}

export function buildWebReferenceList(results: WebSearchResult[]): string {
  const lines = results.map((r, i) => {
    const source = r.url.includes("pubmed.ncbi.nlm.nih.gov") ? " · PubMed" : " · Web";
    return `${i + 1}. **[W${i + 1}] [${r.title}](${r.url})**${source}`;
  });
  return `\n\n**Research Sources (${results.length})**\n${lines.join("\n")}`;
}

export function buildCitationReferenceList(results: SupportingCitation[]): string {
  if (results.length === 0) {
    return "\n\n**Verified DOI Candidates (0)**\nNo DOI-bearing candidate was returned by OpenAlex or Crossref. Do not use an unverified citation.";
  }
  const lines = results.map((result, index) => {
    const authors = result.authors.length > 0
      ? escapeMarkdownText(result.authors.slice(0, 4).join("; "))
      : "Unknown author";
    const title = escapeMarkdownText(result.title || "Untitled");
    const venue = result.journal ? ` _${escapeMarkdownText(result.journal)}_.` : "";
    const doiUrl = `https://doi.org/${encodeURI(result.doi)
      .replace(/\(/g, "%28")
      .replace(/\)/g, "%29")}`;
    return `${index + 1}. **[C${index + 1}] ${authors} (${result.year || "n.d."}). ${title}.**${venue}  \n   DOI: [${escapeMarkdownText(result.doi)}](${doiUrl}) · ${result.sourceDatabase}`;
  });
  return `\n\n**Verified DOI Candidates (${results.length})**\n${lines.join("\n")}`;
}
