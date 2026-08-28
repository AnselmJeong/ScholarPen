export type FileMentionSyntax = "bracketed" | "quoted" | "legacy";

export interface ParsedFileMention {
  value: string;
  syntax: FileMentionSyntax;
}

export interface ActiveFileMention {
  start: number;
  query: string;
}

function isBoundary(value: string, index: number): boolean {
  return index === 0 || /\s/.test(value[index - 1] ?? "");
}

function escapeMentionValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function readEscapedUntil(
  value: string,
  start: number,
  terminator: string,
): { value: string; end: number } | null {
  let result = "";
  let escaped = false;

  for (let index = start; index < value.length; index++) {
    const character = value[index];
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === terminator) return { value: result, end: index + 1 };
    result += character;
  }

  return null;
}

/** Render a dropdown selection as a path-aware token that safely supports spaces. */
export function formatFileMention(displayPath: string): string {
  return `@[${escapeMentionValue(displayPath)}]`;
}

/** Find an unfinished @ query at the end of the composer value. */
export function findActiveFileMention(value: string): ActiveFileMention | null {
  for (let index = value.length - 1; index >= 0; index--) {
    if (value[index] !== "@" || !isBoundary(value, index)) continue;

    const suffix = value.slice(index + 1);
    if (suffix.startsWith("[")) {
      if (readEscapedUntil(suffix, 1, "]")) return null;
      return { start: index, query: suffix.slice(1).toLowerCase() };
    }
    if (suffix.startsWith('"')) {
      if (readEscapedUntil(suffix, 1, '"')) return null;
      return { start: index, query: suffix.slice(1).toLowerCase() };
    }

    return { start: index, query: suffix.toLowerCase() };
  }

  return null;
}

/** Replace the active @ query while preserving the preceding request text. */
export function replaceActiveFileMention(value: string, displayPath: string): string {
  const active = findActiveFileMention(value);
  const mention = formatFileMention(displayPath);
  return active ? `${value.slice(0, active.start)}${mention} ` : `${value}${mention} `;
}

/** Parse current bracketed mentions and legacy whitespace-delimited mentions. */
export function parseFileMentions(value: string): ParsedFileMention[] {
  const mentions: ParsedFileMention[] = [];

  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "@" || !isBoundary(value, index)) continue;
    const next = value[index + 1];

    if (next === "[") {
      const parsed = readEscapedUntil(value, index + 2, "]");
      if (parsed?.value.trim()) {
        mentions.push({ value: parsed.value.trim(), syntax: "bracketed" });
        index = parsed.end - 1;
      }
      continue;
    }

    if (next === '"') {
      const parsed = readEscapedUntil(value, index + 2, '"');
      if (parsed?.value.trim()) {
        mentions.push({ value: parsed.value.trim(), syntax: "quoted" });
        index = parsed.end - 1;
      }
      continue;
    }

    let end = index + 1;
    while (end < value.length && !/\s/.test(value[end])) end++;
    const token = value.slice(index + 1, end).trim();
    if (token) mentions.push({ value: token, syntax: "legacy" });
    index = end - 1;
  }

  return mentions;
}
