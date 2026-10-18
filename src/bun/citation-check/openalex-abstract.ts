import type { BibtexEntry } from "../../shared/bibtex-utils";
import { reconstructOpenAlexAbstract } from "../citation/client";
import { cleanDoi, squash } from "./pdf-text";
import type { CachedAbstract, CitationSourceIndex } from "./source-index";

const OPENALEX = "https://api.openalex.org/works";
const SELECT = "id,doi,title,publication_year,abstract_inverted_index,is_retracted";

interface OpenAlexWork {
  title?: string | null;
  publication_year?: number | null;
  abstract_inverted_index?: Record<string, number[]> | null;
  is_retracted?: boolean;
}

function sameTitle(a: string, b: string): boolean {
  const x = squash(a), y = squash(b);
  if (x.length < 15 || y.length < 15) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // A subtitle present in one record only still matches.
  return long.startsWith(short) && short.length / long.length >= 0.6;
}

function abstractKey(entry: BibtexEntry): string | null {
  const doi = cleanDoi(entry.fields.doi ?? "");
  if (doi) return `doi:${doi}`;
  const title = squash(entry.fields.title ?? "");
  return title.length >= 15 ? `title:${title.slice(0, 120)}` : null;
}

/**
 * The OpenAlex abstract of a bibliography entry: by DOI, or by an exact title
 * (and year) match when it has no DOI. Results, including "no abstract", are
 * cached in the project's citation source index.
 */
export async function fetchOpenAlexAbstract(
  entry: BibtexEntry,
  index: CitationSourceIndex,
  options: { apiKey?: string; signal?: AbortSignal; fetchFn?: typeof fetch } = {},
): Promise<CachedAbstract | null> {
  const key = abstractKey(entry);
  if (!key) return null;
  const cached = await index.cachedAbstract(key);
  if (cached) return cached;
  const params = new URLSearchParams({ select: SELECT, "per-page": "5" });
  if (key.startsWith("doi:")) params.set("filter", `doi:https://doi.org/${key.slice(4)}`);
  else params.set("search", (entry.fields.title ?? "").replace(/[{}\\]/g, "").slice(0, 300));
  if (options.apiKey?.trim()) params.set("api_key", options.apiKey.trim());
  const timeout = AbortSignal.timeout(15_000);
  const response = await (options.fetchFn ?? fetch)(`${OPENALEX}?${params}`, {
    headers: { "User-Agent": "ScholarPen (citation check)" },
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`OpenAlex HTTP ${response.status}`);
  const body = await response.json() as { results?: OpenAlexWork[] };
  const year = Number.parseInt(entry.fields.year ?? "", 10);
  const work = key.startsWith("doi:")
    ? body.results?.[0]
    : body.results?.find(item => item.title && sameTitle(item.title, entry.fields.title ?? "") &&
      (!Number.isFinite(year) || !item.publication_year || Math.abs(item.publication_year - year) <= 1));
  const value: CachedAbstract = {
    abstract: reconstructOpenAlexAbstract(work?.abstract_inverted_index) ?? null,
    title: work?.title ?? null,
    retracted: work?.is_retracted === true,
  };
  await index.storeAbstract(key, value);
  return value;
}
