/** Parse all citekeys from a BibTeX string. */
export function parseBibtexCitekeys(bibtex: string): string[] {
  const keys: string[] = [];
  const re = /@\w+\{([^,\s]+)\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bibtex)) !== null) keys.push(m[1]);
  return keys;
}

/**
 * Build a map of normalized DOI → citekey from a BibTeX string.
 * Used to detect duplicate papers even when citekeys differ.
 */
export function parseBibtexDOIMap(bibtex: string): Map<string, string> {
  const map = new Map<string, string>();
  const entryRe = /@\w+\{([^,\s]+)\s*,([^@]*)/g;
  let entry: RegExpExecArray | null;
  while ((entry = entryRe.exec(bibtex)) !== null) {
    const citekey = entry[1];
    const body = entry[2];
    const doiMatch = body.match(/\bdoi\s*=\s*\{([^}]+)\}/i);
    if (doiMatch) {
      const doi = doiMatch[1].trim().toLowerCase().replace(/^https?:\/\/doi\.org\//i, "");
      map.set(doi, citekey);
    }
  }
  return map;
}

/**
 * Deduplicate BibTeX entries by citekey, keeping the first occurrence.
 * Entries are assumed to be separated by blank lines or a new `@` at the start of a line.
 */
export function deduplicateBibtex(bibtex: string): string {
  const entries = bibtex.split(/\n(?=@)/);
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
