import { Document, parseDocument } from "yaml";
import type { FileNode, QuartoRenderFormat } from "./rpc-types";

export type QuartoBookFormat = "docx" | "html" | "pdf";

export interface QuartoBookConfigInput {
  title: string;
  authors: string[];
  cslFilename: string;
  qmdFilenames: string[];
  language: string;
  outputDir: string;
  bibliographyFiles: string[];
  formats: QuartoBookFormat[];
  existingYaml?: string | null;
}

export interface QuartoBookEditorValues {
  title: string;
  authors: string[];
  cslFilename: string;
  qmdFilenames: string[];
  language: string;
  outputDir: string;
  bibliographyFiles: string[];
  formats: QuartoBookFormat[];
}

const DEFAULT_LANGUAGE = "ko";
const DEFAULT_OUTPUT_DIR = "_book";
const DEFAULT_BIBLIOGRAPHY = "references.bib";
const QUARTO_BOOK_FORMAT_ORDER = ["docx", "html", "pdf"] as const satisfies readonly QuartoBookFormat[];
const QUARTO_RENDER_FORMAT_ORDER = ["docx", "html", "typst"] as const satisfies readonly QuartoRenderFormat[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelativePath(filename: string): boolean {
  if (!filename || filename.includes("\0") || filename.includes("\\")) return false;
  if (filename.startsWith("/") || /^[A-Za-z]:/.test(filename)) return false;
  return !filename.split("/").some((part) => part === "..");
}

function normalizeResourcePaths(
  filenames: string[],
  extension: `.${string}`,
): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawFilename of filenames) {
    const filename = rawFilename.trim();
    if (
      !isSafeRelativePath(filename)
      || !filename.toLowerCase().endsWith(extension)
      || seen.has(filename)
    ) {
      continue;
    }
    seen.add(filename);
    normalized.push(filename);
  }

  return normalized;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readStringList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [item.trim()] : [];
    if (isRecord(item) && typeof item.name === "string" && item.name.trim()) {
      return [item.name.trim()];
    }
    return [];
  });
}

function hasStructuredAuthors(value: unknown): boolean {
  return Array.isArray(value) && value.some(isRecord);
}

function stringListsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseYamlRoot(source: string): Record<string, unknown> {
  const document = parseDocument(source, { prettyErrors: true });
  if (document.errors.length > 0) {
    throw new Error(`Invalid _quarto.yml: ${document.errors[0]?.message ?? "YAML parse error"}`);
  }
  const value: unknown = document.toJS({ maxAliasCount: 100 });
  if (!isRecord(value)) {
    throw new Error("Invalid _quarto.yml: the document root must be a mapping.");
  }
  return value;
}

function readMapping(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new Error(`Invalid _quarto.yml: "${key}" must be a mapping.`);
  }
  return value;
}

function readFormatKeys(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []);
  }
  if (isRecord(value)) return Object.keys(value);
  if (value === undefined || value === null) return [];
  throw new Error('Invalid _quarto.yml: "format" must be a string, list, or mapping.');
}

function readBookFormats(value: unknown): QuartoBookFormat[] {
  const keys = new Set(readFormatKeys(value));
  return QUARTO_BOOK_FORMAT_ORDER.filter((format) => (
    format === "pdf" ? keys.has("typst") || keys.has("pdf") : keys.has(format)
  ));
}

export function getQuartoRenderFormats(source: string): QuartoRenderFormat[] {
  const root = parseYamlRoot(source);
  const keys = new Set(readFormatKeys(root.format));
  return QUARTO_RENDER_FORMAT_ORDER.filter((format) => keys.has(format));
}

function defaultFormatOptions(
  format: QuartoRenderFormat,
  isNewConfiguration: boolean,
): Record<string, unknown> {
  if (format === "docx" && isNewConfiguration) {
    return {
      toc: false,
      "number-sections": false,
    };
  }
  return {};
}

function updateManagedFormats(
  document: Document,
  currentValue: unknown,
  formats: QuartoBookFormat[],
  isNewConfiguration: boolean,
): void {
  const selected = new Set(formats);
  const selectedKeys: QuartoRenderFormat[] = formats.map(
    (format) => format === "pdf" ? "typst" : format,
  );

  if (!isRecord(currentValue)) {
    const preservedUnknownKeys = readFormatKeys(currentValue).filter(
      (key) => !["docx", "html", "pdf", "typst"].includes(key),
    );
    const next: Record<string, unknown> = {};
    for (const key of preservedUnknownKeys) next[key] = {};
    for (const key of selectedKeys) next[key] = defaultFormatOptions(key, isNewConfiguration);
    document.set("format", next);
    return;
  }

  for (const format of ["docx", "html"] as const) {
    if (selected.has(format)) {
      if (!(format in currentValue)) {
        document.setIn(["format", format], defaultFormatOptions(format, isNewConfiguration));
      }
    } else {
      document.deleteIn(["format", format]);
    }
  }

  if (selected.has("pdf")) {
    if (!("typst" in currentValue)) {
      document.setIn(["format", "typst"], defaultFormatOptions("typst", isNewConfiguration));
    }
  } else {
    document.deleteIn(["format", "typst"]);
  }
  document.deleteIn(["format", "pdf"]);
}

export function parseQuartoBookConfig(
  source: string | null | undefined,
  availableQmdFilenames: string[],
): QuartoBookEditorValues {
  const availableChapters = sortQuartoChapterFilenames(availableQmdFilenames);
  if (!source?.trim()) {
    return {
      title: "",
      authors: [""],
      cslFilename: "",
      qmdFilenames: availableChapters,
      language: DEFAULT_LANGUAGE,
      outputDir: DEFAULT_OUTPUT_DIR,
      bibliographyFiles: [DEFAULT_BIBLIOGRAPHY],
      formats: ["docx"],
    };
  }

  const root = parseYamlRoot(source);
  const project = readMapping(root, "project");
  const book = readMapping(root, "book");
  const authors = readStringList(book.author);
  const configuredChapters = normalizeResourcePaths(readStringList(book.chapters), ".qmd");
  const bibliographyFiles = normalizeResourcePaths(
    readStringList(root.bibliography),
    ".bib",
  );

  return {
    title: readString(book.title, ""),
    authors: authors.length > 0 ? authors : [""],
    cslFilename: readString(root.csl, ""),
    qmdFilenames: configuredChapters,
    language: readString(book.language, DEFAULT_LANGUAGE),
    outputDir: readString(project["output-dir"], DEFAULT_OUTPUT_DIR),
    bibliographyFiles: bibliographyFiles.length > 0
      ? bibliographyFiles
      : [DEFAULT_BIBLIOGRAPHY],
    formats: readBookFormats(root.format),
  };
}

export function sortQuartoChapterFilenames(filenames: string[]): string[] {
  return normalizeResourcePaths(filenames, ".qmd").sort((left, right) => {
    const leftIsIndex = left.toLowerCase() === "index.qmd";
    const rightIsIndex = right.toLowerCase() === "index.qmd";
    if (leftIsIndex !== rightIsIndex) return leftIsIndex ? -1 : 1;
    return left.localeCompare(right, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

export function collectQuartoChapterFilenames(nodes: FileNode[]): string[] {
  const exportsDirectory = nodes.find(
    (node) => node.isDirectory && node.name === "exports",
  );
  if (!exportsDirectory?.children) return [];
  return sortQuartoChapterFilenames(
    exportsDirectory.children
      .filter((node) => !node.isDirectory)
      .map((node) => node.name),
  );
}

export function findQuartoConfigNode(nodes: FileNode[]): FileNode | null {
  const exportsDirectory = nodes.find(
    (node) => node.isDirectory && node.name === "exports",
  );
  return exportsDirectory?.children?.find(
    (node) => !node.isDirectory && node.name === "_quarto.yml",
  ) ?? null;
}

export function buildQuartoBookConfig(input: QuartoBookConfigInput): string {
  const title = input.title.trim();
  const authors = input.authors.map((author) => author.trim()).filter(Boolean);
  const requestedChapters = input.qmdFilenames.map((filename) => filename.trim()).filter(Boolean);
  const chapters = normalizeResourcePaths(requestedChapters, ".qmd");
  const cslFilename = input.cslFilename.trim();
  const language = input.language.trim();
  const outputDir = input.outputDir.trim();
  const requestedBibliographies = input.bibliographyFiles
    .map((filename) => filename.trim())
    .filter(Boolean);
  const bibliographyFiles = normalizeResourcePaths(requestedBibliographies, ".bib");
  const formats = QUARTO_BOOK_FORMAT_ORDER.filter((format) => input.formats.includes(format));

  if (!title) throw new Error("A book title is required.");
  if (authors.length === 0) throw new Error("At least one author is required.");
  if (chapters.length === 0) throw new Error("Select at least one QMD chapter.");
  if (chapters.length !== requestedChapters.length) {
    throw new Error("One or more chapter paths are invalid or duplicated.");
  }
  if (!isSafeRelativePath(cslFilename) || !cslFilename.toLowerCase().endsWith(".csl")) {
    throw new Error("Choose a valid CSL file.");
  }
  if (!language) throw new Error("A book language is required.");
  if (!isSafeRelativePath(outputDir)) throw new Error("Choose a valid output directory.");
  if (bibliographyFiles.length === 0) {
    throw new Error("Add at least one valid BibTeX bibliography.");
  }
  if (bibliographyFiles.length !== requestedBibliographies.length) {
    throw new Error("One or more bibliography paths are invalid or duplicated.");
  }
  if (formats.length === 0) throw new Error("Select at least one output format.");
  if (
    formats.length !== input.formats.length
    || new Set(input.formats).size !== input.formats.length
  ) {
    throw new Error("One or more output formats are invalid or duplicated.");
  }

  const existingYaml = input.existingYaml ?? "";
  const existingSource = existingYaml.trim();
  const document = existingSource
    ? parseDocument(existingYaml, { prettyErrors: true })
    : new Document({});

  if (document.errors.length > 0) {
    throw new Error(`Invalid _quarto.yml: ${document.errors[0]?.message ?? "YAML parse error"}`);
  }
  const rootValue: unknown = document.toJS({ maxAliasCount: 100 });
  if (!isRecord(rootValue)) {
    throw new Error("Invalid _quarto.yml: the document root must be a mapping.");
  }

  const existingBook = readMapping(rootValue, "book");
  readMapping(rootValue, "project");
  const existingAuthorValue = existingBook.author;
  const keepStructuredAuthors = hasStructuredAuthors(existingAuthorValue)
    && stringListsEqual(readStringList(existingAuthorValue), authors);

  document.setIn(["project", "type"], "book");
  document.setIn(["project", "output-dir"], outputDir);
  document.setIn(["book", "title"], title);
  if (!keepStructuredAuthors) document.setIn(["book", "author"], authors);
  document.setIn(["book", "language"], language);
  document.setIn(["book", "chapters"], chapters);
  document.set(
    "bibliography",
    bibliographyFiles.length === 1 ? bibliographyFiles[0] : bibliographyFiles,
  );
  document.set("csl", cslFilename);
  updateManagedFormats(document, rootValue.format, formats, !existingSource);

  return document.toString({ lineWidth: 0 });
}
