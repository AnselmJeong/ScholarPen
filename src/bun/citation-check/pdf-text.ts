import type { ExtractedPdfPage } from "../project-sources/pdf-extractor";

export type PdfChunkKind = "lead" | "body" | "refs";

export interface PdfChunk {
  ordinal: number;
  page: number;
  kind: PdfChunkKind;
  content: string;
}

const CHUNK_CHARS = 900;
const LEAD_CHARS = 1_800;
const MAX_SENTENCE_CHARS = 1_400;

/** Lowercased letters and digits only: survives PDF hyphenation, ligature gaps and punctuation. */
export function squash(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\\[a-zA-Z]+|[{}]/g, "")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function cleanDoi(value: string): string {
  return value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "")
    .replace(/[.,;:)\]}>'"’”]+$/, "").toLowerCase();
}

export function detectDois(text: string): string[] {
  return [...new Set([...text.matchAll(/\b10\.\d{4,9}\/[^\s"<>]+/gi)].map(match => cleanDoi(match[0])))];
}

// Signs of a bibliography entry: "2015;14:301", "14(3): 301", "(2015). ", "doi: 10.", "Benedetti F, ".
const REFERENCE_PATTERNS = [
  /\b(?:19|20)\d{2}\s*;\s*\d+/g,
  /\b\d+\s*\(\d+\)\s*[:,]\s*\d+/g,
  /\((?:19|20)\d{2}[a-z]?\)\.\s/g,
  /\bdoi\s*:?\s*10\.\d{4,}/gi,
  /\b[A-Z][a-z]+\s[A-Z]{1,2}[,.]\s/g,
];
const REFERENCES_HEADING = /\b(?:References|REFERENCES|Bibliography|BIBLIOGRAPHY|Literature Cited|Works Cited|참고문헌)\b\s*(?:\[?1[.\]]|[A-Z][a-z]+,?\s+[A-Z])/;

export function referenceScore(text: string): number {
  return REFERENCE_PATTERNS.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0);
}

function sentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?。])\s+/);
  return parts.flatMap(part => {
    if (part.length <= MAX_SENTENCE_CHARS) return [part];
    const pieces: string[] = [];
    for (let at = 0; at < part.length; at += MAX_SENTENCE_CHARS) pieces.push(part.slice(at, at + MAX_SENTENCE_CHARS));
    return pieces;
  });
}

/**
 * Splits extracted pages into overlapping passages of a few sentences. The start of
 * page 1 (title, authors, abstract) is the "lead"; the bibliography is marked "refs"
 * so retrieval does not return other papers' titles as evidence.
 */
export function chunkPdfPages(pages: readonly ExtractedPdfPage[]): PdfChunk[] {
  const chunks: PdfChunk[] = [];
  const total = pages.length;
  let inReferences = false;
  let leadChars = 0;
  for (const page of pages) {
    const text = page.content.replace(/\s+/g, " ").trim();
    if (!text) continue;
    let buffer: string[] = [];
    let length = 0;
    let fresh = 0;
    const add = (sentence: string) => { buffer.push(sentence); length += sentence.length + 1; fresh += 1; };
    const flush = (carry: boolean) => {
      const content = buffer.join(" ").trim();
      if (content && fresh > 0) {
        const lead = page.pageNumber === 1 && leadChars < LEAD_CHARS;
        if (lead) leadChars += content.length;
        const refs = !lead && (inReferences || referenceScore(content) >= 5);
        chunks.push({ ordinal: chunks.length, page: page.pageNumber, kind: lead ? "lead" : refs ? "refs" : "body", content });
      }
      // Carry the last sentence over so a claim that straddles two passages is still found whole.
      const last = buffer.at(-1);
      buffer = carry && last && last.length < 300 ? [last] : [];
      length = buffer[0]?.length ?? 0;
      fresh = 0;
    };
    for (const sentence of sentences(text)) {
      // The bibliography starts at a "References" heading in the back half of the paper.
      if (!inReferences && page.pageNumber > Math.max(1, total * 0.4) && REFERENCES_HEADING.test(sentence)) {
        const at = sentence.search(REFERENCES_HEADING);
        const before = sentence.slice(0, at).trim();
        if (before) add(before);
        flush(false);
        inReferences = true;
        add(sentence.slice(at).trim());
        continue;
      }
      add(sentence);
      if (length >= CHUNK_CHARS) flush(true);
    }
    flush(false);
  }
  return chunks;
}

const STOP_WORDS = new Set(("a an and are as at be been but by can could did do does for from had has have how in into is it its " +
  "may might more most no not of on or our than that the their them then there these they this those to was were what when where " +
  "which while who will with would also between such other others some study studies effect effects result results " +
  "found shown show shows showed suggest suggests suggested").split(" "));

/** FTS5 query: any of the queries' significant words, each quoted so punctuation cannot inject syntax. */
export function ftsQueryFor(queries: readonly string[], maxTerms = 28): string | null {
  const terms: string[] = [];
  for (const query of queries) {
    for (const word of query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? []) {
      const term = word.replace(/^-+|-+$/g, "");
      if (term.length < 3 || STOP_WORDS.has(term) || terms.includes(term)) continue;
      terms.push(term);
      if (terms.length >= maxTerms) break;
    }
  }
  return terms.length ? terms.map(term => `"${term.replace(/"/g, "")}"`).join(" OR ") : null;
}

/** Does every part of a (possibly elided) quote occur in the source text? */
export function quoteOccursIn(quote: string, source: string): boolean {
  const haystack = squash(source);
  const parts = quote.split(/\.{3,}|…|\[\s*\.\.\.\s*\]/).map(squash).filter(part => part.length >= 12);
  return parts.length > 0 && parts.every(part => haystack.includes(part));
}
