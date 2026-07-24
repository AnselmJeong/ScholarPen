import type { CitationMetadata } from "../../shared/rpc-types";

export interface SupportingCitation extends CitationMetadata {
  abstract?: string;
  sourceDatabase: "OpenAlex" | "Crossref";
}

const SEARCH_STOP_WORDS = new Set([
  "about", "after", "also", "among", "because", "before", "between", "could",
  "from", "have", "into", "more", "most", "other", "should", "than", "that",
  "their", "there", "these", "this", "those", "through", "using", "were",
  "when", "where", "which", "while", "with", "would",
]);

function normalizeDOI(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "");
}

function isDOI(value: string): boolean {
  return /^10\.\d{4,9}\/\S+$/i.test(value);
}

function cleanAbstract(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

export function reconstructOpenAlexAbstract(
  invertedIndex: Record<string, number[]> | null | undefined,
): string | undefined {
  if (!invertedIndex) return undefined;
  const positionedWords: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const position of positions) positionedWords.push([position, word]);
  }
  if (positionedWords.length === 0) return undefined;
  positionedWords.sort((a, b) => a[0] - b[0]);
  return positionedWords.map(([, word]) => word).join(" ");
}

export function buildCitationSearchQueries(selectedText: string): string[] {
  const normalized = selectedText.replace(/\s+/g, " ").trim().slice(0, 900);
  if (!normalized) return [];

  const latinTerms = Array.from(
    new Set(
      (normalized.match(/\p{Script=Latin}[\p{Script=Latin}\p{N}-]{2,}/gu) ?? [])
        .filter((term) => !SEARCH_STOP_WORDS.has(term.toLowerCase()))
        .map((term) => term.trim()),
    ),
  ).slice(0, 24);
  const keywordQuery = latinTerms.join(" ").slice(0, 500);
  const letterCount = (normalized.match(/\p{L}/gu) ?? []).length;
  const latinLetterCount = (normalized.match(/\p{Script=Latin}/gu) ?? []).length;
  const hasNonLatinLetters = letterCount > latinLetterCount;
  const ordered = hasNonLatinLetters ? [keywordQuery, normalized] : [normalized, keywordQuery];
  return Array.from(new Set(ordered.filter((query) => query.length >= 3)));
}

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

  async findSupportingCitations(
    selectedText: string,
    limit = 8,
    openAlexApiKey?: string,
    signal?: AbortSignal,
  ): Promise<SupportingCitation[]> {
    const queries = buildCitationSearchQueries(selectedText);
    if (queries.length === 0) return [];

    const tasks = queries.flatMap((query) => [
      this.searchOpenAlexSupporting(query, limit, openAlexApiKey, signal),
      this.searchCrossrefSupporting(query, limit, signal),
    ]);
    const settled = await Promise.allSettled(tasks);
    const candidates = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const byDOI = new Map<string, SupportingCitation>();

    for (const candidate of candidates) {
      const doi = normalizeDOI(candidate.doi);
      if (!isDOI(doi)) continue;
      const normalized = { ...candidate, doi };
      const key = doi.toLowerCase();
      const existing = byDOI.get(key);
      if (
        !existing ||
        (!existing.abstract && normalized.abstract) ||
        (normalized.abstract?.length ?? 0) > (existing.abstract?.length ?? 0)
      ) {
        byDOI.set(key, normalized);
      }
    }

    return Array.from(byDOI.values()).slice(0, Math.max(1, Math.min(20, limit)));
  }

  private async searchOpenAlexSupporting(
    query: string,
    limit: number,
    apiKey?: string,
    signal?: AbortSignal,
  ): Promise<SupportingCitation[]> {
    const params = new URLSearchParams({
      search: query,
      per_page: String(Math.max(1, Math.min(20, limit))),
    });
    if (apiKey?.trim()) params.set("api_key", apiKey.trim());
    const res = await fetch(`https://api.openalex.org/works?${params}`, {
      headers: { "User-Agent": "ScholarPen/1.0 (mailto:scholarpen@example.com)" },
      signal,
    });
    if (!res.ok) throw new Error(`OpenAlex error: HTTP ${res.status}`);

    const data = await res.json() as { results?: OpenAlexWork[] };
    return (data.results ?? [])
      .map((work) => {
        const metadata = this.parseOpenAlexWork(work);
        return {
          ...metadata,
          abstract: reconstructOpenAlexAbstract(work.abstract_inverted_index),
          sourceDatabase: "OpenAlex" as const,
        };
      })
      .filter((candidate) => isDOI(normalizeDOI(candidate.doi)));
  }

  private async searchCrossrefSupporting(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SupportingCitation[]> {
    const params = new URLSearchParams({
      query,
      rows: String(Math.max(1, Math.min(20, limit))),
    });
    const res = await fetch(`https://api.crossref.org/works?${params}`, {
      headers: { "User-Agent": "ScholarPen/1.0 (mailto:scholarpen@example.com)" },
      signal,
    });
    if (!res.ok) throw new Error(`Crossref search error: HTTP ${res.status}`);

    const data = await res.json() as { message?: { items?: CrossRefWork[] } };
    return (data.message?.items ?? [])
      .map((work) => this.parseCrossrefWork(work))
      .filter((candidate): candidate is SupportingCitation => candidate !== null);
  }

  private parseCrossrefWork(work: CrossRefWork): SupportingCitation | null {
    const doi = normalizeDOI(work.DOI);
    if (!isDOI(doi)) return null;
    const authors = (work.author || []).map((a) => `${a.family || ""}${a.given ? `, ${a.given}` : ""}`);
    const year =
      work.published?.["date-parts"]?.[0]?.[0] ??
      work["published-print"]?.["date-parts"]?.[0]?.[0] ??
      work["published-online"]?.["date-parts"]?.[0]?.[0] ??
      0;
    const firstAuthor = work.author?.[0]?.family?.toLowerCase().replace(/\s+/g, "") ?? "unknown";
    const title = work.title?.[0] ?? "";
    const titleWord = title.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, "");
    const citekey = `${firstAuthor}${year}${titleWord}`;
    return {
      doi,
      citekey,
      title,
      authors,
      year,
      journal: work["container-title"]?.[0],
      volume: work.volume,
      pages: work.page,
      bibtex: this.buildBibtex({
        citekey,
        doi,
        title,
        authors: work.author || [],
        year,
        journal: work["container-title"]?.[0],
        volume: work.volume,
        pages: work.page,
      }),
      abstract: cleanAbstract(work.abstract),
      sourceDatabase: "Crossref",
    };
  }

  private parseOpenAlexWork(work: OpenAlexWork): CitationMetadata {
    const authors = (work.authorships || []).map((a) => a.author?.display_name ?? "");
    const year = work.publication_year ?? 0;
    const doi = normalizeDOI(work.doi);
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
  "published-print"?: { "date-parts": number[][] };
  "published-online"?: { "date-parts": number[][] };
  "container-title"?: string[];
  volume?: string;
  page?: string;
  DOI?: string;
  abstract?: string;
}

interface OpenAlexWork {
  title?: string;
  doi?: string;
  publication_year?: number;
  authorships?: Array<{ author?: { display_name?: string } }>;
  primary_location?: { source?: { display_name?: string } };
  abstract_inverted_index?: Record<string, number[]> | null;
}

export const citationClient = new CitationClient();
