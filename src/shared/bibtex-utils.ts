export interface BibtexEntry {
  entryType: string;
  citekey: string;
  fields: Record<string, string>;
  raw: string;
  start: number;
  end: number;
}

export interface BibtexParseIssue {
  message: string;
  offset: number;
}

export interface BibtexParseResult {
  entries: BibtexEntry[];
  issues: BibtexParseIssue[];
}

/** Parse all citekeys from a BibTeX string. */
export function parseBibtexCitekeys(bibtex: string): string[] {
  return parseBibtexEntries(bibtex).entries.map((entry) => entry.citekey);
}

/**
 * Build a map of normalized DOI → citekey from a BibTeX string.
 * Used to detect duplicate papers even when citekeys differ.
 */
export function parseBibtexDOIMap(bibtex: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of parseBibtexEntries(bibtex).entries) {
    const doi = normalizeDoi(entry.fields.doi);
    if (doi) map.set(doi, entry.citekey);
  }
  return map;
}

export function normalizeDoi(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[.,;)\]}]+$/g, "")
    .replace(/\/+$/g, "")
    .toLowerCase();
}

export function parseBibtexEntries(bibtex: string): BibtexParseResult {
  const entries: BibtexEntry[] = [];
  const issues: BibtexParseIssue[] = [];
  let i = 0;

  while (i < bibtex.length) {
    const at = bibtex.indexOf("@", i);
    if (at === -1) break;

    const header = bibtex.slice(at).match(/^@([a-zA-Z]+)\s*\{/);
    if (!header) {
      issues.push({ message: "Invalid BibTeX entry header.", offset: at });
      i = at + 1;
      continue;
    }

    const bodyStart = at + header[0].length;
    let depth = 1;
    let quote = false;
    let escaped = false;
    let pos = bodyStart;

    for (; pos < bibtex.length; pos++) {
      const ch = bibtex[pos];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          quote = false;
        }
        continue;
      }
      if (ch === "\"") quote = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }

    if (depth !== 0) {
      issues.push({ message: "Unclosed BibTeX entry.", offset: at });
      break;
    }

    const raw = bibtex.slice(at, pos + 1).trim();
    const body = bibtex.slice(bodyStart, pos);
    const comma = findTopLevelComma(body);
    if (comma === -1) {
      issues.push({ message: "BibTeX entry is missing a citekey.", offset: at });
      i = pos + 1;
      continue;
    }

    const citekey = body.slice(0, comma).trim();
    if (!citekey) {
      issues.push({ message: "BibTeX entry has an empty citekey.", offset: at });
      i = pos + 1;
      continue;
    }

    entries.push({
      entryType: header[1].toLowerCase(),
      citekey,
      fields: parseBibtexFields(body.slice(comma + 1)),
      raw,
      start: at,
      end: pos + 1,
    });
    i = pos + 1;
  }

  return { entries, issues };
}

function findTopLevelComma(text: string): number {
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") quote = false;
      continue;
    }
    if (ch === "\"") quote = true;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "," && depth === 0) return i;
  }
  return -1;
}

function parseBibtexFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i])) i++;
    const name = body.slice(i).match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*=/);
    if (!name) {
      i++;
      continue;
    }
    const key = name[1].toLowerCase();
    i += name[0].length;
    while (i < body.length && /\s/.test(body[i])) i++;

    const parsed = readFieldValue(body, i);
    fields[key] = parsed.value.trim();
    i = parsed.next;
  }
  return fields;
}

function readFieldValue(text: string, start: number): { value: string; next: number } {
  const first = text[start];
  if (first === "{") {
    let depth = 1;
    let i = start + 1;
    for (; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    return { value: text.slice(start + 1, i), next: i + 1 };
  }

  if (first === "\"") {
    let escaped = false;
    let i = start + 1;
    for (; i < text.length; i++) {
      if (escaped) escaped = false;
      else if (text[i] === "\\") escaped = true;
      else if (text[i] === "\"") break;
    }
    return { value: text.slice(start + 1, i), next: i + 1 };
  }

  let i = start;
  while (i < text.length && text[i] !== ",") i++;
  return { value: text.slice(start, i), next: i };
}

function normalizeIdentityPart(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[{}\\]/g, "")
    .replace(/[^a-z0-9가-힣一-龥ぁ-ゔァ-ヴー々〆〤\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstAuthor(author: string | undefined): string {
  return normalizeIdentityPart((author ?? "").split(/\s+and\s+/i)[0]);
}

export function getBibtexIdentityKey(entry: BibtexEntry): string | null {
  const doi = normalizeDoi(entry.fields.doi);
  if (doi) return `doi:${doi}`;
  const title = normalizeIdentityPart(entry.fields.title);
  const author = firstAuthor(entry.fields.author);
  const year = normalizeIdentityPart(entry.fields.year);
  if (title && author && year) return `title:${title}|author:${author}|year:${year}`;
  return null;
}

export function findDuplicateBibtexGroups(entries: BibtexEntry[]): BibtexEntry[][] {
  const byCitekey = new Map<string, BibtexEntry[]>();
  const byIdentity = new Map<string, BibtexEntry[]>();

  for (const entry of entries) {
    const citekey = entry.citekey.toLowerCase();
    byCitekey.set(citekey, [...(byCitekey.get(citekey) ?? []), entry]);
    const identity = getBibtexIdentityKey(entry);
    if (identity) byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), entry]);
  }

  const groups: BibtexEntry[][] = [];
  const seen = new Set<string>();
  for (const group of [...byCitekey.values(), ...byIdentity.values()]) {
    if (group.length < 2) continue;
    const key = group.map((entry) => entry.start).sort((a, b) => a - b).join(",");
    if (!seen.has(key)) {
      seen.add(key);
      groups.push(group);
    }
  }
  return groups;
}

/**
 * Deduplicate BibTeX entries by citekey, keeping the first occurrence.
 * Entries are assumed to be separated by blank lines or a new `@` at the start of a line.
 */
export function deduplicateBibtex(bibtex: string): string {
  const entries = parseBibtexEntries(bibtex).entries.map((entry) => entry.raw);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/@\w+\{([^,\s]+)\s*,/);
    if (m) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        unique.push(trimmed);
      }
    } else {
      unique.push(trimmed);
    }
  }
  return unique.join("\n\n");
}
