import {
  applyBibtexFieldUpdates,
  normalizeDoi,
  parseBibtexEntries,
  type BibtexEntry,
} from "../../shared/bibtex-utils";
import type {
  BibliographyEntryValidation,
  BibliographyFieldValidation,
  BibliographyValidationProgress,
  JournalAbbreviationValidation,
} from "../../shared/rpc-types";

type ProgressReporter = (progress: BibliographyValidationProgress) => void;

interface CrossrefAuthor {
  family?: string;
  given?: string;
}

export interface CrossrefValidationWork {
  DOI?: string;
  type?: string;
  title?: string[];
  author?: CrossrefAuthor[];
  published?: { "date-parts"?: number[][] };
  "published-print"?: { "date-parts"?: number[][] };
  "published-online"?: { "date-parts"?: number[][] };
  "container-title"?: string[];
  "short-container-title"?: string[];
  volume?: string;
  issue?: string;
  page?: string;
  "article-number"?: string;
  ISSN?: string[];
}

export interface ResolvedEntry {
  entry: BibtexEntry;
  work?: CrossrefValidationWork;
  matchMethod?: "doi" | "bibliographic";
  confidence?: number;
  error?: string;
  unsupported?: boolean;
}

export interface NlmAbbreviation {
  iso?: string;
  title?: string;
}

const SUPPORTED_ENTRY_TYPES = new Set([
  "article",
  "book",
  "inbook",
  "incollection",
  "inproceedings",
  "proceedings",
]);

const CROSSREF_LIST_SELECT = [
  "DOI",
  "type",
  "title",
  "author",
  "published",
  "published-print",
  "published-online",
  "container-title",
  "short-container-title",
  "volume",
  "issue",
  "page",
  "article-number",
  "ISSN",
].join(",");

function decodeLatex(value: string | undefined): string {
  return (value ?? "")
    .replace(/\\(?:['"`^~=Huvcdb])\s*\{?([A-Za-z])\}?/g, "$1")
    .replace(/\\(?:ae|AE|oe|OE|aa|AA|o|O|l|L)\b/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\\([&%_$#])/g, "$1");
}

export function normalizeBibliographicText(value: string | undefined): string {
  return decodeLatex(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenDice(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  let overlap = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) overlap++;
  });
  return (2 * overlap) / (leftTokens.size + rightTokens.size);
}

function titleSimilarity(entry: BibtexEntry, work: CrossrefValidationWork): number {
  return tokenDice(
    normalizeBibliographicText(entry.fields.title),
    normalizeBibliographicText(work.title?.[0]),
  );
}

function bibtexAuthorFamilies(value: string | undefined): string[] {
  return (value ?? "")
    .split(/\s+and\s+/i)
    .map((author) => author.trim())
    .filter((author) => author && author.toLocaleLowerCase() !== "others")
    .map((author) => {
      const comma = author.indexOf(",");
      const family = comma >= 0
        ? author.slice(0, comma)
        : author.split(/\s+/).at(-1) ?? author;
      return normalizeBibliographicText(family);
    });
}

function crossrefAuthorFamilies(work: CrossrefValidationWork): string[] {
  return (work.author ?? [])
    .map((author) => normalizeBibliographicText(author.family))
    .filter(Boolean);
}

function canonicalAuthors(work: CrossrefValidationWork): string | undefined {
  if (!work.author?.length) return undefined;
  return work.author
    .map((author) => [author.family, author.given].filter(Boolean).join(", "))
    .filter(Boolean)
    .join(" and ");
}

function publicationYear(work: CrossrefValidationWork): number | undefined {
  return work.published?.["date-parts"]?.[0]?.[0]
    ?? work["published-print"]?.["date-parts"]?.[0]?.[0]
    ?? work["published-online"]?.["date-parts"]?.[0]?.[0];
}

function authorSimilarity(entry: BibtexEntry, work: CrossrefValidationWork): number {
  const current = bibtexAuthorFamilies(entry.fields.author);
  const canonical = crossrefAuthorFamilies(work);
  if (current.length === 0 || canonical.length === 0) return 0;
  const compared = Math.min(current.length, canonical.length);
  let matches = 0;
  for (let index = 0; index < compared; index++) {
    if (current[index] === canonical[index]) matches++;
  }
  if (/\s+and\s+others\s*$/i.test(entry.fields.author ?? "") && matches === current.length) {
    return 1;
  }
  return matches / Math.max(current.length, canonical.length);
}

export function scoreCrossrefCandidate(
  entry: BibtexEntry,
  work: CrossrefValidationWork,
): number {
  const title = titleSimilarity(entry, work);
  const authors = authorSimilarity(entry, work);
  const currentYear = Number(entry.fields.year);
  const candidateYear = publicationYear(work);
  const year = Number.isFinite(currentYear) && candidateYear
    ? currentYear === candidateYear ? 1 : Math.abs(currentYear - candidateYear) === 1 ? 0.5 : 0
    : 0.5;
  return title * 0.78 + authors * 0.14 + year * 0.08;
}

export function isStrongCrossrefCandidate(
  entry: BibtexEntry,
  work: CrossrefValidationWork,
): boolean {
  const currentAuthors = bibtexAuthorFamilies(entry.fields.author);
  const candidateAuthors = crossrefAuthorFamilies(work);
  const firstAuthorMatches = currentAuthors.length === 0
    || candidateAuthors.length === 0
    || currentAuthors[0] === candidateAuthors[0];
  const currentYear = Number(entry.fields.year);
  const candidateYear = publicationYear(work);
  const yearMatches = !Number.isFinite(currentYear)
    || !candidateYear
    || Math.abs(currentYear - candidateYear) <= 1;
  return titleSimilarity(entry, work) >= 0.9
    && firstAuthorMatches
    && yearMatches
    && scoreCrossrefCandidate(entry, work) >= 0.88;
}

function normalizedPages(value: string | undefined): string {
  return (value ?? "").replace(/[–—-]+/g, "-").replace(/\s+/g, "").toLocaleLowerCase();
}

function fieldValidation(
  field: BibliographyFieldValidation["field"],
  current: string | undefined,
  canonical: string | undefined,
  matches?: (left: string, right: string) => boolean,
): BibliographyFieldValidation {
  if (!canonical) return { field, status: "unavailable", current };
  if (!current) return { field, status: "missing", canonical };
  const equal = matches
    ? matches(current, canonical)
    : normalizeBibliographicText(current) === normalizeBibliographicText(canonical);
  return { field, status: equal ? "match" : "mismatch", current, canonical };
}

function fetchErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Metadata lookup failed.";
}

async function fetchJson<T>(url: string, fetchFn: typeof fetch): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchFn(url, {
        headers: { "User-Agent": "ScholarPen/1.0" },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return await response.json() as T;
      if (response.status === 404) throw new Error("No matching Crossref record was found.");
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`Metadata service returned HTTP ${response.status}.`);
      }
      lastError = new Error(`Metadata service returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message.includes("No matching")) throw error;
    }
    await Bun.sleep(400 * (attempt + 1));
  }
  throw lastError instanceof Error ? lastError : new Error("Metadata lookup failed.");
}

async function resolveEntry(
  entry: BibtexEntry,
  fetchFn: typeof fetch,
): Promise<ResolvedEntry> {
  if (!SUPPORTED_ENTRY_TYPES.has(entry.entryType)) return { entry, unsupported: true };
  const doi = normalizeDoi(entry.fields.doi);
  if (doi) {
    try {
      const data = await fetchJson<{ message: CrossrefValidationWork }>(
        `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
        fetchFn,
      );
      return { entry, work: data.message, matchMethod: "doi", confidence: 1 };
    } catch (error) {
      return { entry, error: fetchErrorMessage(error) };
    }
  }

  const firstAuthor = bibtexAuthorFamilies(entry.fields.author)[0] ?? "";
  const query = [entry.fields.title, firstAuthor, entry.fields.year].filter(Boolean).join(" ");
  if (!entry.fields.title || query.length < 4) {
    return { entry, error: "A title is required to find a missing DOI." };
  }
  const params = new URLSearchParams({
    "query.bibliographic": query,
    rows: "3",
    select: CROSSREF_LIST_SELECT,
  });
  try {
    const data = await fetchJson<{ message?: { items?: CrossrefValidationWork[] } }>(
      `https://api.crossref.org/works?${params}`,
      fetchFn,
    );
    const candidates = (data.message?.items ?? [])
      .filter((work) => normalizeDoi(work.DOI))
      .sort((left, right) => scoreCrossrefCandidate(entry, right) - scoreCrossrefCandidate(entry, left));
    const match = candidates.find((work) => isStrongCrossrefCandidate(entry, work));
    if (!match) return { entry, error: "No sufficiently reliable DOI match was found." };
    return {
      entry,
      work: match,
      matchMethod: "bibliographic",
      confidence: scoreCrossrefCandidate(entry, match),
    };
  } catch (error) {
    return { entry, error: fetchErrorMessage(error) };
  }
}

async function fetchNlmAbbreviations(
  issns: string[],
  fetchFn: typeof fetch,
): Promise<Map<string, NlmAbbreviation>> {
  const result = new Map<string, NlmAbbreviation>();
  for (let start = 0; start < issns.length; start += 25) {
    const chunk = issns.slice(start, start + 25);
    const searchParams = new URLSearchParams({
      db: "nlmcatalog",
      term: chunk.map((issn) => `${issn}[ISSN]`).join(" OR "),
      retmax: String(chunk.length * 2),
      retmode: "json",
      tool: "ScholarPen",
    });
    try {
      const search = await fetchJson<{
        esearchresult?: { idlist?: string[] };
      }>(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${searchParams}`, fetchFn);
      const ids = search.esearchresult?.idlist ?? [];
      if (ids.length === 0) continue;
      const summaryParams = new URLSearchParams({
        db: "nlmcatalog",
        id: ids.join(","),
        retmode: "json",
        tool: "ScholarPen",
      });
      const summary = await fetchJson<{
        result?: Record<string, unknown> & { uids?: string[] };
      }>(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${summaryParams}`, fetchFn);
      for (const id of summary.result?.uids ?? []) {
        const record = summary.result?.[id] as {
          issnlist?: Array<{ issn?: string }>;
          isoabbreviation?: string;
          medlineta?: string;
        } | undefined;
        if (!record) continue;
        const abbreviation = {
          iso: record.isoabbreviation?.trim() || undefined,
          title: record.medlineta?.trim() || undefined,
        };
        for (const item of record.issnlist ?? []) {
          if (item.issn) result.set(item.issn.toLocaleLowerCase(), abbreviation);
        }
      }
    } catch (error) {
      console.warn("[Bibliography] NLM abbreviation lookup failed:", error);
    }
  }
  return result;
}

function journalAbbreviation(
  work: CrossrefValidationWork,
  nlmByIssn: Map<string, NlmAbbreviation>,
): JournalAbbreviationValidation | undefined {
  for (const issn of work.ISSN ?? []) {
    const nlm = nlmByIssn.get(issn.toLocaleLowerCase());
    if (nlm?.iso) return { value: nlm.iso, source: "nlm-iso", verified: true };
    if (nlm?.title) return { value: nlm.title, source: "nlm-title", verified: true };
  }
  const publisherValue = work["short-container-title"]?.[0]?.trim();
  return publisherValue
    ? { value: publisherValue, source: "crossref-publisher", verified: false }
    : undefined;
}

export function buildEntryValidation(
  resolved: ResolvedEntry,
  nlmByIssn = new Map<string, NlmAbbreviation>(),
): BibliographyEntryValidation {
  const { entry, work } = resolved;
  if (resolved.unsupported) {
    return {
      citekey: entry.citekey,
      entryType: entry.entryType,
      status: "unsupported",
      fields: [],
      message: `@${entry.entryType} entries are not validated automatically.`,
    };
  }
  if (!work) {
    return {
      citekey: entry.citekey,
      entryType: entry.entryType,
      status: resolved.error?.includes("HTTP") ? "error" : "unverified",
      fields: [],
      message: resolved.error ?? "No verified metadata was found.",
    };
  }

  const abbreviation = journalAbbreviation(work, nlmByIssn);
  const canonicalDoi = normalizeDoi(work.DOI);
  const canonicalYear = publicationYear(work)?.toString();
  const canonicalJournal = work["container-title"]?.[0];
  const canonicalPages = work.page ?? work["article-number"];
  const canonicalAuthor = canonicalAuthors(work);
  const acceptedJournalNames = [
    canonicalJournal,
    work["short-container-title"]?.[0],
    abbreviation?.value,
  ].filter((value): value is string => Boolean(value));
  const fields: BibliographyFieldValidation[] = [
    fieldValidation("title", entry.fields.title, work.title?.[0]),
    fieldValidation("author", entry.fields.author, canonicalAuthor, () => authorSimilarity(entry, work) === 1),
    fieldValidation("year", entry.fields.year, canonicalYear),
    fieldValidation("doi", entry.fields.doi, canonicalDoi, (left, right) => normalizeDoi(left) === normalizeDoi(right)),
  ];
  if (entry.entryType === "article") {
    fields.push(
      fieldValidation("journal", entry.fields.journal, canonicalJournal, (left) => {
        const normalized = normalizeBibliographicText(left);
        return acceptedJournalNames.some((name) => normalizeBibliographicText(name) === normalized);
      }),
      fieldValidation("volume", entry.fields.volume, work.volume),
      fieldValidation("number", entry.fields.number, work.issue),
      fieldValidation("pages", entry.fields.pages, canonicalPages, (left, right) => normalizedPages(left) === normalizedPages(right)),
    );
  }

  const identityMismatch = fields.some(
    (field) => (field.field === "title" || field.field === "author") && field.status === "mismatch",
  );
  const suggestedFields: Record<string, string> = {};
  if (!identityMismatch) {
    if (canonicalDoi && normalizeDoi(entry.fields.doi) !== canonicalDoi) suggestedFields.doi = canonicalDoi;
    if (entry.entryType === "article") {
      if (work.volume && entry.fields.volume !== work.volume) suggestedFields.volume = work.volume;
      if (work.issue && entry.fields.number !== work.issue) suggestedFields.number = work.issue;
      if (canonicalPages && normalizedPages(entry.fields.pages) !== normalizedPages(canonicalPages)) {
        suggestedFields.pages = canonicalPages.replace(/[–—-]+/g, "--");
      }
      if (abbreviation?.verified
        && normalizeBibliographicText(entry.fields.journal) !== normalizeBibliographicText(abbreviation.value)) {
        suggestedFields.journal = abbreviation.value;
      }
    }
  }
  const hasIssue = fields.some((field) => field.status === "missing" || field.status === "mismatch");
  return {
    citekey: entry.citekey,
    entryType: entry.entryType,
    status: hasIssue || Object.keys(suggestedFields).length > 0 ? "changes" : "valid",
    matchMethod: resolved.matchMethod,
    doi: canonicalDoi || undefined,
    confidence: resolved.confidence,
    fields,
    journalAbbreviation: abbreviation,
    suggestedFields: Object.keys(suggestedFields).length > 0 ? suggestedFields : undefined,
    message: identityMismatch
      ? "The DOI record does not match the current title or authors closely enough for automatic correction."
      : undefined,
  };
}

export async function validateBibliography(
  bibtex: string,
  onProgress?: ProgressReporter,
  fetchFn: typeof fetch = fetch,
): Promise<{ validations: BibliographyEntryValidation[]; suggestedBibtex: string }> {
  const parsed = parseBibtexEntries(bibtex);
  if (parsed.issues.length > 0) {
    const issue = parsed.issues[0];
    throw new Error(`BibTeX parse error at line ${issue.line}, column ${issue.column}: ${issue.message}`);
  }
  const resolved: ResolvedEntry[] = [];
  for (let index = 0; index < parsed.entries.length; index++) {
    const entry = parsed.entries[index];
    resolved.push(await resolveEntry(entry, fetchFn));
    onProgress?.({
      stage: "crossref",
      processed: index + 1,
      total: parsed.entries.length,
      message: `Crossref 검증 ${index + 1}/${parsed.entries.length}`,
    });
    if (index < parsed.entries.length - 1) {
      await Bun.sleep(normalizeDoi(entry.fields.doi) ? 220 : 1050);
    }
  }

  const issns = Array.from(new Set(
    resolved.flatMap((item) => item.work?.ISSN ?? []).filter(Boolean),
  ));
  onProgress?.({
    stage: "abbreviations",
    processed: 0,
    total: issns.length,
    message: "NLM 저널 표준 약어 확인 중",
  });
  const nlmByIssn = await fetchNlmAbbreviations(issns, fetchFn);
  const validations = resolved.map((item) => buildEntryValidation(item, nlmByIssn));
  const updates = Object.fromEntries(
    validations
      .filter((item) => item.suggestedFields)
      .map((item) => [item.citekey, item.suggestedFields!]),
  );
  return {
    validations,
    suggestedBibtex: applyBibtexFieldUpdates(bibtex, updates),
  };
}
