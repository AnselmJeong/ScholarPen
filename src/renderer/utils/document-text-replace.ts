export type TextPath = Array<string | number>;

export interface DocumentTextMatch {
  path: TextPath;
  offset: number;
  length: number;
  snippet: string;
  snippetOffset: number;
}

export interface DocumentReplacementResult {
  content: unknown;
  replacementCount: number;
}

interface TextLeaf {
  path: TextPath;
  value: string;
}

const SEARCHABLE_PROP_KEYS = new Set(["caption", "altText"]);

function isSearchableString(path: TextPath, key: string): boolean {
  if (key === "text" || key === "content") return true;
  return path.at(-1) === "props" && SEARCHABLE_PROP_KEYS.has(key);
}

function collectTextLeaves(value: unknown, path: TextPath = []): TextLeaf[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectTextLeaves(item, [...path, index]));
  }
  if (!value || typeof value !== "object") return [];

  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const childPath = [...path, key];
    if (typeof child === "string") {
      return isSearchableString(path, key) ? [{ path: childPath, value: child }] : [];
    }
    return collectTextLeaves(child, childPath);
  });
}

function occurrenceOffsets(value: string, searchTerm: string): number[] {
  if (!searchTerm) return [];
  const offsets: number[] = [];
  const haystack = value.toLocaleLowerCase();
  const needle = searchTerm.toLocaleLowerCase();
  let cursor = 0;

  while (cursor <= haystack.length - needle.length) {
    const offset = haystack.indexOf(needle, cursor);
    if (offset === -1) break;
    offsets.push(offset);
    cursor = offset + searchTerm.length;
  }

  return offsets;
}

function buildSnippet(
  value: string,
  offset: number,
  length: number,
): { snippet: string; snippetOffset: number } {
  const radius = 34;
  const start = Math.max(0, offset - radius);
  const end = Math.min(value.length, offset + length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < value.length ? "…" : "";
  const rawBeforeMatch = value.slice(start, offset);
  const normalizeLineBreaks = (text: string) => text.replace(/\r?\n/g, " ↵ ");
  const normalizedBeforeMatch = normalizeLineBreaks(rawBeforeMatch);
  return {
    snippet: `${prefix}${normalizeLineBreaks(value.slice(start, end))}${suffix}`,
    snippetOffset: prefix.length + normalizedBeforeMatch.length,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getStringAtPath(root: unknown, path: TextPath): string {
  let current = root;
  for (const segment of path) {
    current = (current as Record<string | number, unknown>)[segment];
  }
  if (typeof current !== "string") throw new Error("Text path no longer points to a string.");
  return current;
}

function setStringAtPath(root: unknown, path: TextPath, value: string): void {
  let current = root as Record<string | number, unknown>;
  for (const segment of path.slice(0, -1)) {
    current = current[segment] as Record<string | number, unknown>;
  }
  current[path.at(-1)!] = value;
}

export function findDocumentTextMatches(
  content: unknown,
  searchTerm: string,
): DocumentTextMatch[] {
  if (!searchTerm) return [];

  return collectTextLeaves(content).flatMap((leaf) =>
    occurrenceOffsets(leaf.value, searchTerm).map((offset) => {
      const preview = buildSnippet(leaf.value, offset, searchTerm.length);
      return {
        path: leaf.path,
        offset,
        length: searchTerm.length,
        ...preview,
      };
    }),
  );
}

export function replaceDocumentText(
  content: unknown,
  searchTerm: string,
  replacement: string,
  matchIndex?: number,
): DocumentReplacementResult {
  const matches = findDocumentTextMatches(content, searchTerm);
  const selectedMatches = matchIndex === undefined
    ? matches
    : matches[matchIndex]
      ? [matches[matchIndex]]
      : [];

  if (selectedMatches.length === 0) {
    return { content, replacementCount: 0 };
  }

  const next = cloneJson(content);
  const matchesByPath = new Map<string, DocumentTextMatch[]>();
  for (const match of selectedMatches) {
    const key = JSON.stringify(match.path);
    const group = matchesByPath.get(key) ?? [];
    group.push(match);
    matchesByPath.set(key, group);
  }

  for (const group of matchesByPath.values()) {
    const path = group[0].path;
    let value = getStringAtPath(next, path);
    for (const match of [...group].sort((a, b) => b.offset - a.offset)) {
      value = value.slice(0, match.offset) + replacement + value.slice(match.offset + match.length);
    }
    setStringAtPath(next, path, value);
  }

  return { content: next, replacementCount: selectedMatches.length };
}
