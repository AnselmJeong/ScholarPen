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

export interface BibtexDeduplicationPlan {
  bibtex: string;
  duplicateGroups: BibtexEntry[][];
  removedEntries: number;
  citekeyRemap: Record<string, string>;
}

export interface CitationRemapResult {
  content: unknown;
  replacementCount: number;
}

export interface BibtexUnusedCleanupPlan {
  bibtex: string;
  removedEntries: BibtexEntry[];
}

export interface DoiCitationInsertionPlan {
  bibtex: string;
  citekey: string;
  changed: boolean;
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
      if (ch === "\\") {
        pos++;
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

/** Collect citekeys only from structured BlockNote citation nodes. */
export function collectDocumentCitationKeys(
  value: unknown,
  keys = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectDocumentCitationKeys(item, keys));
    return keys;
  }
  if (!value || typeof value !== "object") return keys;

  const obj = value as Record<string, unknown>;
  const props = obj.props && typeof obj.props === "object"
    ? obj.props as Record<string, unknown>
    : null;
  if (obj.type === "citation") {
    const citekey = typeof props?.citekey === "string"
      ? props.citekey
      : typeof obj.citekey === "string"
        ? obj.citekey
        : "";
    if (citekey.trim()) keys.add(citekey.trim());
  }
  Object.values(obj).forEach((nested) => collectDocumentCitationKeys(nested, keys));
  return keys;
}

export function removeUnusedBibtexEntries(
  bibtex: string,
  usedCitekeys: Iterable<string>,
): BibtexUnusedCleanupPlan {
  const parsed = parseBibtexEntries(bibtex);
  if (parsed.issues.length > 0) {
    throw new Error(`BibTeX parse error: ${parsed.issues[0].message}`);
  }
  const used = new Set(
    Array.from(usedCitekeys, (citekey) => citekey.toLocaleLowerCase()),
  );
  const removedEntries = parsed.entries.filter(
    (entry) => !used.has(entry.citekey.toLocaleLowerCase()),
  );
  let next = bibtex;
  for (const entry of [...removedEntries].sort((left, right) => right.start - left.start)) {
    next = `${next.slice(0, entry.start)}${next.slice(entry.end)}`;
  }
  return {
    bibtex: removedEntries.length > 0
      ? next.replace(/\n{3,}/g, "\n\n").trim()
      : bibtex,
    removedEntries,
  };
}

function serializeBibtexEntry(entry: BibtexEntry, updates: Record<string, string>): string {
  const fields = { ...entry.fields };
  const orderedFields = Object.keys(fields);
  for (const [field, value] of Object.entries(updates)) {
    if (!Object.prototype.hasOwnProperty.call(fields, field)) orderedFields.push(field);
    fields[field] = value;
  }
  const lines = orderedFields.map((field) => `  ${field} = {${fields[field]}},`);
  if (lines.length > 0) lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, "");
  return [`@${entry.entryType}{${entry.citekey},`, ...lines, "}"].join("\n");
}

/** Apply reviewed field updates without changing citekeys or entry order. */
export function applyBibtexFieldUpdates(
  bibtex: string,
  updatesByCitekey: Record<string, Record<string, string>>,
): string {
  const parsed = parseBibtexEntries(bibtex);
  let next = bibtex;
  for (const entry of [...parsed.entries].sort((left, right) => right.start - left.start)) {
    const updates = updatesByCitekey[entry.citekey];
    if (!updates || Object.keys(updates).length === 0) continue;
    const replacement = serializeBibtexEntry(entry, updates);
    next = `${next.slice(0, entry.start)}${replacement}${next.slice(entry.end)}`;
  }
  return next;
}

function replaceEntryCitekey(raw: string, citekey: string): string {
  return raw.replace(/^(@[a-zA-Z]+\s*\{)\s*([^,]+)(,)/, `$1${citekey}$3`);
}

function entriesShareTitleAuthorYear(left: BibtexEntry, right: BibtexEntry): boolean {
  const leftKeys = getBibtexIdentityKeys(left).filter((key) => key.startsWith("title:"));
  const rightKeys = new Set(
    getBibtexIdentityKeys(right).filter((key) => key.startsWith("title:")),
  );
  return leftKeys.some((key) => rightKeys.has(key));
}

/**
 * Merge one DOI-resolved entry into a bibliography. A DOI is mandatory, an
 * existing DOI wins regardless of citekey, and citekey collisions never point
 * a new citation at an unrelated entry.
 */
export function buildDoiCitationInsertionPlan(
  bibtex: string,
  resolvedBibtex: string,
  expectedDoi: string,
): DoiCitationInsertionPlan {
  const normalizedExpectedDoi = normalizeDoi(expectedDoi);
  if (!normalizedExpectedDoi) throw new Error("Resolved citation is missing a DOI.");

  const resolved = parseBibtexEntries(resolvedBibtex);
  if (resolved.issues.length > 0 || resolved.entries.length !== 1) {
    throw new Error("DOI lookup did not return exactly one valid BibTeX entry.");
  }
  const candidate = resolved.entries[0];
  if (normalizeDoi(candidate.fields.doi) !== normalizedExpectedDoi) {
    throw new Error("Resolved BibTeX entry does not contain the requested DOI.");
  }

  const existing = parseBibtexEntries(bibtex);
  if (existing.issues.length > 0) {
    throw new Error(`Existing BibTeX cannot be updated: ${existing.issues[0].message}`);
  }
  const doiMatch = existing.entries.find(
    (entry) => normalizeDoi(entry.fields.doi) === normalizedExpectedDoi,
  );
  if (doiMatch) return { bibtex, citekey: doiMatch.citekey, changed: false };

  const citekeyMatch = existing.entries.find(
    (entry) => entry.citekey.toLocaleLowerCase() === candidate.citekey.toLocaleLowerCase(),
  );
  if (citekeyMatch && !normalizeDoi(citekeyMatch.fields.doi)
    && entriesShareTitleAuthorYear(citekeyMatch, candidate)) {
    return {
      bibtex: applyBibtexFieldUpdates(bibtex, {
        [citekeyMatch.citekey]: { doi: normalizedExpectedDoi },
      }),
      citekey: citekeyMatch.citekey,
      changed: true,
    };
  }

  const usedCitekeys = new Set(existing.entries.map((entry) => entry.citekey.toLocaleLowerCase()));
  let citekey = candidate.citekey;
  if (usedCitekeys.has(citekey.toLocaleLowerCase())) {
    let suffix = "a";
    while (usedCitekeys.has(`${candidate.citekey}${suffix}`.toLocaleLowerCase())) {
      suffix = String.fromCharCode(suffix.charCodeAt(0) + 1);
    }
    citekey = `${candidate.citekey}${suffix}`;
  }
  const raw = replaceEntryCitekey(candidate.raw, citekey);
  return {
    bibtex: [bibtex.trim(), raw.trim()].filter(Boolean).join("\n\n"),
    citekey,
    changed: true,
  };
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
    if (ch === "\\") {
      i++;
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
      if (text[i] === "\\") {
        i++;
      } else if (text[i] === "{") depth++;
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
  const raw = (author ?? "").split(/\s+and\s+/i)[0].trim();
  const comma = raw.indexOf(",");
  if (comma === -1) return normalizeIdentityPart(raw);
  const family = raw.slice(0, comma);
  const given = raw.slice(comma + 1);
  return normalizeIdentityPart(`${given} ${family}`);
}

export function getBibtexIdentityKey(entry: BibtexEntry): string | null {
  return getBibtexIdentityKeys(entry)[0] ?? null;
}

export function getBibtexIdentityKeys(entry: BibtexEntry): string[] {
  const keys: string[] = [];
  const doi = normalizeDoi(entry.fields.doi);
  if (doi) keys.push(`doi:${doi}`);
  const title = normalizeIdentityPart(entry.fields.title);
  const author = firstAuthor(entry.fields.author);
  const year = normalizeIdentityPart(entry.fields.year);
  if (title && author && year) {
    keys.push(`title:${title}|author:${author}|year:${year}`);
  }
  return keys;
}

export function areBibtexEntriesDuplicates(
  left: BibtexEntry,
  right: BibtexEntry,
): boolean {
  if (left.citekey.toLocaleLowerCase() === right.citekey.toLocaleLowerCase()) return true;
  const leftKeys = new Set(getBibtexIdentityKeys(left));
  return getBibtexIdentityKeys(right).some((key) => leftKeys.has(key));
}

export function findDuplicateBibtexGroups(entries: BibtexEntry[]): BibtexEntry[][] {
  const parents = entries.map((_, index) => index);
  const find = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  const firstByCitekey = new Map<string, number>();
  const firstByIdentity = new Map<string, number>();
  entries.forEach((entry, index) => {
    const citekey = entry.citekey.toLocaleLowerCase();
    const citekeyMatch = firstByCitekey.get(citekey);
    if (citekeyMatch === undefined) firstByCitekey.set(citekey, index);
    else union(citekeyMatch, index);

    for (const identity of getBibtexIdentityKeys(entry)) {
      const identityMatch = firstByIdentity.get(identity);
      if (identityMatch === undefined) firstByIdentity.set(identity, index);
      else union(identityMatch, index);
    }
  });

  const groupedIndexes = new Map<number, number[]>();
  entries.forEach((_, index) => {
    const root = find(index);
    groupedIndexes.set(root, [...(groupedIndexes.get(root) ?? []), index]);
  });

  return [...groupedIndexes.values()]
    .filter((indexes) => indexes.length > 1)
    .map((indexes) => indexes.sort((a, b) => a - b).map((index) => entries[index]))
    .sort((left, right) => left[0].start - right[0].start);
}

/**
 * Build one deterministic cleanup plan for citekey and bibliographic-identity
 * duplicates. The first entry in source order survives each duplicate group.
 */
export function buildBibtexDeduplicationPlan(bibtex: string): BibtexDeduplicationPlan {
  const parsed = parseBibtexEntries(bibtex);
  const duplicateGroups = findDuplicateBibtexGroups(parsed.entries);
  const entriesToRemove: BibtexEntry[] = [];
  const citekeyRemap: Record<string, string> = {};

  for (const group of duplicateGroups) {
    const survivor = group[0];
    for (const duplicate of group.slice(1)) {
      entriesToRemove.push(duplicate);
      if (duplicate.citekey !== survivor.citekey) {
        citekeyRemap[duplicate.citekey] = survivor.citekey;
      }
    }
  }

  let next = bibtex;
  for (const entry of entriesToRemove.sort((a, b) => b.start - a.start)) {
    next = `${next.slice(0, entry.start)}${next.slice(entry.end)}`;
  }

  return {
    bibtex: entriesToRemove.length > 0
      ? next.replace(/\n{3,}/g, "\n\n").trim()
      : bibtex,
    duplicateGroups,
    removedEntries: entriesToRemove.length,
    citekeyRemap,
  };
}

/**
 * Rewrite citekeys only inside structured BlockNote citation nodes.
 * Prose, locators, formatting, and unrelated metadata remain untouched.
 */
export function remapDocumentCitationKeys(
  content: unknown,
  citekeyRemap: Record<string, string>,
): CitationRemapResult {
  if (Object.keys(citekeyRemap).length === 0) {
    return { content, replacementCount: 0 };
  }

  const exact = new Map(Object.entries(citekeyRemap));
  const caseInsensitive = new Map(
    Object.entries(citekeyRemap).map(([from, to]) => [from.toLocaleLowerCase(), to]),
  );
  const next = JSON.parse(JSON.stringify(content)) as unknown;
  let replacementCount = 0;

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;

    const obj = value as Record<string, unknown>;
    if (obj.type === "citation") {
      const props = obj.props && typeof obj.props === "object"
        ? obj.props as Record<string, unknown>
        : null;
      const citekeyOwner = props && typeof props.citekey === "string"
        ? props
        : typeof obj.citekey === "string"
          ? obj
          : null;
      const citekey = citekeyOwner?.citekey;
      if (citekeyOwner && typeof citekey === "string") {
        const replacement = exact.get(citekey)
          ?? caseInsensitive.get(citekey.toLocaleLowerCase());
        if (replacement && replacement !== citekey) {
          citekeyOwner.citekey = replacement;
          replacementCount++;
        }
      }
    }

    Object.values(obj).forEach(visit);
  };

  visit(next);
  return { content: next, replacementCount };
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
