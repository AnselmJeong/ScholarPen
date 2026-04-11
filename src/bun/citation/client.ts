import type { CitationMetadata } from "../../shared/rpc-types";

class CitationClient {
  // CrossRef → DOI 해석
  async resolveDOI(doi: string): Promise<CitationMetadata> {
    const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//i, "");
    const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(cleanDoi)}`, {
      headers: { "User-Agent": "ScholarPen/0.1.0 (mailto:scholarpen@example.com)" },
    });
    if (!res.ok) throw new Error(`CrossRef error: HTTP ${res.status} for DOI ${cleanDoi}`);

    const data = await res.json() as { message: CrossRefWork };
    const work = data.message;

    const authors = (work.author || []).map((a) => `${a.family || ""}${a.given ? `, ${a.given}` : ""}`);
    const year = work.published?.["date-parts"]?.[0]?.[0] ?? 0;
    const firstAuthor = work.author?.[0]?.family?.toLowerCase().replace(/\s+/g, "") ?? "unknown";
    const titleWord = (work.title?.[0] ?? "").split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, "");
    const citekey = `${firstAuthor}${year}${titleWord}`;

    const bibtex = this.buildBibtex({
      citekey,
      doi: cleanDoi,
      title: work.title?.[0] ?? "",
      authors: work.author || [],
      year,
      journal: work["container-title"]?.[0],
      volume: work.volume,
      pages: work.page,
    });

    return { doi: cleanDoi, citekey, title: work.title?.[0] ?? "", authors, year, journal: work["container-title"]?.[0], volume: work.volume, pages: work.page, bibtex };
  }

  // OpenAlex → 학술 검색
  async searchOpenAlex(query: string, limit = 10, apiKey?: string): Promise<CitationMetadata[]> {
    const params = new URLSearchParams({ search: query, per_page: String(limit) });
    if (apiKey) params.set("api_key", apiKey);
    const res = await fetch(`https://api.openalex.org/works?${params}`, {
      headers: { "User-Agent": "ScholarPen/0.1.0" },
    });
    if (!res.ok) return [];

    const data = await res.json() as { results: OpenAlexWork[] };
    return data.results.map((work) => this.parseOpenAlexWork(work));
  }

  private parseOpenAlexWork(work: OpenAlexWork): CitationMetadata {
    const authors = (work.authorships || []).map((a) => a.author?.display_name ?? "");
    const year = work.publication_year ?? 0;
    const doi = (work.doi ?? "").replace("https://doi.org/", "");
    const firstAuthor = authors[0]?.split(" ").at(-1)?.toLowerCase() ?? "unknown";
    const titleWord = (work.title ?? "").split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, "");
    const citekey = `${firstAuthor}${year}${titleWord}`;

    return {
      doi,
      citekey,
      title: work.title ?? "",
      authors,
      year,
      journal: work.primary_location?.source?.display_name,
      bibtex: "",
    };
  }

  private buildBibtex(opts: {
    citekey: string;
    doi: string;
    title: string;
    authors: Array<{ family?: string; given?: string }>;
    year: number;
    journal?: string;
    volume?: string;
    pages?: string;
  }): string {
    const authorStr = opts.authors.map((a) => `${a.family ?? ""}, ${a.given ?? ""}`).join(" and ");
    const lines = [
      `@article{${opts.citekey},`,
      `  author = {${authorStr}},`,
      `  title = {${opts.title}},`,
      `  year = {${opts.year}},`,
    ];
    if (opts.journal) lines.push(`  journal = {${opts.journal}},`);
    if (opts.volume) lines.push(`  volume = {${opts.volume}},`);
    if (opts.pages) lines.push(`  pages = {${opts.pages}},`);
    if (opts.doi) lines.push(`  doi = {${opts.doi}},`);
    lines.push("}");
    return lines.join("\n");
  }
}

// CrossRef API types (minimal)
interface CrossRefWork {
  title?: string[];
  author?: Array<{ family?: string; given?: string }>;
  published?: { "date-parts": number[][] };
  "container-title"?: string[];
  volume?: string;
  page?: string;
  DOI?: string;
}

interface OpenAlexWork {
  title?: string;
  doi?: string;
  publication_year?: number;
  authorships?: Array<{ author?: { display_name?: string } }>;
  primary_location?: { source?: { display_name?: string } };
}

export const citationClient = new CitationClient();
