import { basename } from "path";
import { parse as parseYaml } from "yaml";

export interface DigestMetadata {
  schemaVersion?: string;
  title: string;
  authors: string[];
  year?: number;
  doi?: string;
  journal?: string;
  keywords: string[];
  outputLanguage?: string;
  validationStatus?: string;
  sourceRelpath?: string;
  sourceSha256?: string;
  sourceSizeBytes?: number;
  sourcePageCount?: number;
}

export interface DigestChunk {
  ordinal: number;
  headingPath: string;
  content: string;
  lineStart: number;
  lineEnd: number;
  pageStart?: number;
  pageEnd?: number;
}

export interface ParsedDigest {
  metadata: DigestMetadata;
  chunks: DigestChunk[];
}

const MAX_CHUNK_CHARS = 4_200;
const CHUNK_OVERLAP_LINES = 2;

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(stringValue).filter((item): item is string => Boolean(item));
  const scalar = stringValue(value);
  return scalar ? scalar.split(/[,;]/).map((item) => item.trim()).filter(Boolean) : [];
}

function filenameMetadata(filePath: string): { title?: string; authors: string[]; year?: number } {
  const stem = basename(filePath).replace(/\.md$/i, "");
  const match = stem.match(/^(\d{4})\s+-\s+(.+?)\s+-\s+(.+)$/);
  if (!match) return { title: stem, authors: [] };
  return {
    year: Number(match[1]),
    authors: match[2].split(/\s*(?:,|&|\band\b)\s*/i).filter(Boolean),
    title: match[3].trim(),
  };
}

function splitFrontmatter(markdown: string): { attributes: Record<string, unknown>; body: string; bodyLineOffset: number } {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { attributes: {}, body: lines.join("\n"), bodyLineOffset: 0 };
  const end = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (end < 0) return { attributes: {}, body: lines.join("\n"), bodyLineOffset: 0 };
  const closingIndex = end + 1;
  try {
    return {
      attributes: recordValue(parseYaml(lines.slice(1, closingIndex).join("\n"))),
      body: lines.slice(closingIndex + 1).join("\n"),
      bodyLineOffset: closingIndex + 1,
    };
  } catch {
    return { attributes: {}, body: lines.join("\n"), bodyLineOffset: 0 };
  }
}

function pageRange(value: string): { start?: number; end?: number } {
  const matches = [...value.matchAll(/\[Source:[^\]]*?\bpp?\.\s*(\d+)(?:\s*[–—-]\s*(\d+))?[^\]]*\]/gi)];
  const pages = matches.flatMap((match) => [Number(match[1]), Number(match[2] ?? match[1])]);
  if (pages.length === 0) return {};
  return { start: Math.min(...pages), end: Math.max(...pages) };
}

function splitSection(lines: string[], lineStart: number): Array<{ content: string; lineStart: number; lineEnd: number }> {
  const parts: Array<{ content: string; lineStart: number; lineEnd: number }> = [];
  let cursor = 0;
  while (cursor < lines.length) {
    let end = cursor;
    let chars = 0;
    while (end < lines.length && (chars + lines[end].length + 1 <= MAX_CHUNK_CHARS || end === cursor)) {
      chars += lines[end].length + 1;
      end += 1;
    }
    const content = lines.slice(cursor, end).join("\n").trim();
    if (content) {
      parts.push({ content, lineStart: lineStart + cursor, lineEnd: lineStart + end - 1 });
    }
    if (end >= lines.length) break;
    cursor = Math.max(cursor + 1, end - CHUNK_OVERLAP_LINES);
  }
  return parts;
}

function chunkBody(body: string, bodyLineOffset: number): DigestChunk[] {
  const lines = body.split("\n");
  const chunks: DigestChunk[] = [];
  const headings = ["", "", ""];
  let sectionStart = 0;
  let sectionHeading = "Overview";

  const flush = (endExclusive: number) => {
    const sectionLines = lines.slice(sectionStart, endExclusive);
    for (const part of splitSection(sectionLines, bodyLineOffset + sectionStart + 1)) {
      const range = pageRange(part.content);
      chunks.push({
        ordinal: chunks.length,
        headingPath: sectionHeading,
        content: part.content,
        lineStart: part.lineStart,
        lineEnd: part.lineEnd,
        pageStart: range.start,
        pageEnd: range.end,
      });
    }
  };

  lines.forEach((line, index) => {
    const match = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (!match) return;
    if (index > sectionStart) flush(index);
    const level = match[1].length;
    headings[level - 1] = match[2].trim();
    for (let deeper = level; deeper < headings.length; deeper += 1) headings[deeper] = "";
    sectionHeading = headings.filter(Boolean).join(" > ");
    sectionStart = index;
  });
  flush(lines.length);
  return chunks.filter((chunk) => chunk.content.replace(/^#{1,3}\s+.+$/m, "").trim());
}

export function parseDigest(markdown: string, filePath: string): ParsedDigest {
  const { attributes, body, bodyLineOffset } = splitFrontmatter(markdown);
  const fromFilename = filenameMetadata(filePath);
  const firstHeading = body.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  const title = stringValue(attributes.title) ?? firstHeading ?? fromFilename.title ?? basename(filePath, ".md");
  return {
    metadata: {
      schemaVersion: stringValue(attributes.schema_version),
      title,
      authors: stringList(attributes.authors).length > 0 ? stringList(attributes.authors) : fromFilename.authors,
      year: numberValue(attributes.year) ?? fromFilename.year,
      doi: stringValue(attributes.doi),
      journal: stringValue(attributes.journal),
      keywords: stringList(attributes.keywords),
      outputLanguage: stringValue(attributes.output_language),
      validationStatus: stringValue(attributes.validation_status),
      sourceRelpath: stringValue(attributes.source_relpath),
      sourceSha256: stringValue(attributes.source_sha256),
      sourceSizeBytes: numberValue(attributes.source_size_bytes),
      sourcePageCount: numberValue(attributes.source_page_count),
    },
    chunks: chunkBody(body, bodyLineOffset),
  };
}
