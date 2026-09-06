export type TextPath = Array<string | number>;

export interface DocumentTextMatch {
  path: TextPath;
  offset: number;
  length: number;
  segments: Array<{ path: TextPath; offset: number; length: number }>;
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

interface TextRun { leaves: TextLeaf[] }

// Only traverse the document body schema. Never recurse into arbitrary props,
// URLs, image data, citation identifiers, history or other metadata.
function collectTextRuns(content: unknown): TextRun[] {
  const runs: TextRun[] = [];
  function inline(value: unknown, path: TextPath, run: TextRun) {
    if (typeof value === "string") {
      run.leaves.push({ path, value });
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => inline(item, [...path, index], run));
    } else if (value && typeof value === "object") {
      const item = value as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        run.leaves.push({ path: [...path, "text"], value: item.text });
      } else if (item.type === "link") {
        inline(item.content, [...path, "content"], run);
      } else {
        // An inline atom (citation, footnote, math) separates prose runs.
        runs.push({ leaves: run.leaves });
        run.leaves = [];
      }
    }
  }
  function body(value: unknown, path: TextPath) {
    const run: TextRun = { leaves: [] };
    inline(value, path, run);
    runs.push(run);
  }
  function blocks(value: unknown, path: TextPath) {
    if (!Array.isArray(value)) return;
    value.forEach((value, index) => {
      if (!value || typeof value !== "object") return;
      const block = value as Record<string, unknown>;
      const blockPath = [...path, index];
      const content = block.content as Record<string, unknown> | undefined;
      if (content && content.type === "tableContent" && Array.isArray(content.rows)) {
        content.rows.forEach((row, r) => {
          if (!Array.isArray(row.cells)) return;
          row.cells.forEach((cell: unknown, c: number) => {
            const cellPath = [...blockPath, "content", "rows", r, "cells", c];
            // BlockNote supports both legacy inline arrays and tableCell objects.
            if (cell && typeof cell === "object" && !Array.isArray(cell)) {
              body((cell as Record<string, unknown>).content, [...cellPath, "content"]);
            } else body(cell, cellPath);
          });
        });
      } else body(block.content, [...blockPath, "content"]);
      blocks(block.children, [...blockPath, "children"]);
    });
  }
  blocks(content, []);
  return runs.filter((run) => run.leaves.length > 0);
}

export function occurrenceOffsets(value: string, searchTerm: string): number[] {
  if (!searchTerm) return [];
  // Regex preserves offsets in the original UTF-16 string even when case
  // folding changes length (for example capital dotted I before a match).
  const escaped = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Array.from(value.matchAll(new RegExp(escaped, "giu")), (match) => match.index!);
}

export function buildSnippet(
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

  return collectTextRuns(content).flatMap((run) => {
    const value = run.leaves.map((leaf) => leaf.value).join("");
    return occurrenceOffsets(value, searchTerm).map((offset) => {
      let cursor = 0;
      const segments = run.leaves.flatMap((leaf) => {
        const start = Math.max(offset, cursor);
        const end = Math.min(offset + searchTerm.length, cursor + leaf.value.length);
        const segment = { path: leaf.path, offset: start - cursor, length: end - start };
        cursor += leaf.value.length;
        return end > start ? [segment] : [];
      });
      return {
        path: segments[0].path,
        offset: segments[0].offset,
        length: searchTerm.length,
        segments,
        ...buildSnippet(value, offset, searchTerm.length),
      };
    });
  });
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
  const matchesByPath = new Map<string, Array<{ path: TextPath; offset: number; length: number; replacement: string }>>();
  for (const match of selectedMatches) {
    match.segments.forEach((segment, index) => {
      const key = JSON.stringify(segment.path);
      const group = matchesByPath.get(key) ?? [];
      group.push({ ...segment, replacement: index === 0 ? replacement : "" });
      matchesByPath.set(key, group);
    });
  }

  for (const group of matchesByPath.values()) {
    const path = group[0].path;
    let value = getStringAtPath(next, path);
    for (const match of [...group].sort((a, b) => b.offset - a.offset)) {
      value = value.slice(0, match.offset) + match.replacement + value.slice(match.offset + match.length);
    }
    setStringAtPath(next, path, value);
  }

  return { content: next, replacementCount: selectedMatches.length };
}
