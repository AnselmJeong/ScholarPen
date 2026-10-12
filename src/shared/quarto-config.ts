import { Document, isMap, isNode, isScalar, parseDocument } from "yaml";
import type { YAMLMap } from "yaml";
import type { FileNode, QuartoRenderFormat } from "./rpc-types";

export type QuartoBookFormat = string;
export type QuartoSectionNumbering = "all" | "chapters" | "none";
export type QuartoFigureNumbering = "chapter" | "continuous";

/** Optional book settings the dialog edits, each stored under one Quarto key. */
export interface QuartoBookOptions {
  /** `book.subtitle`. */
  subtitle: string;
  /** Book-wide `number-sections` and `number-depth`. */
  sectionNumbering: QuartoSectionNumbering;
  /** `link-citations`. */
  linkCitations: boolean;
  /** `format.docx.toc`. */
  docxToc: boolean;
  /**
   * `format.docx.crossref.chapters`. Word only: an HTML book restarts
   * continuous numbers in every chapter, and Typst books ignore it.
   */
  docxFigureNumbering: QuartoFigureNumbering;
  /** `format.docx.reference-doc`, relative to `_quarto.yml`. */
  docxReferenceDoc: string;
  /** `format.typst.papersize`; empty keeps Typst's default. */
  typstPaperSize: string;
}

export const DEFAULT_QUARTO_BOOK_OPTIONS: Readonly<QuartoBookOptions> = {
  subtitle: "",
  sectionNumbering: "all",
  linkCitations: false,
  docxToc: false,
  docxFigureNumbering: "chapter",
  docxReferenceDoc: "",
  typstPaperSize: "",
};

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
  /** Extra format keys the dialog manages; other keys are preserved. */
  extensionFormats?: string[];
  /** Omitted options keep what the existing YAML says. */
  options?: QuartoBookOptions;
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
  options: QuartoBookOptions;
}

const DEFAULT_LANGUAGE = "ko";
const DEFAULT_OUTPUT_DIR = "_book";
const DEFAULT_BIBLIOGRAPHY = "references.bib";
const QUARTO_BOOK_FORMAT_ORDER = ["docx", "html", "pdf"] as const satisfies readonly QuartoBookFormat[];
const QUARTO_RENDER_FORMAT_ORDER = ["docx", "html", "typst"] as const satisfies readonly QuartoRenderFormat[];
/** Built-in formats whose own numbering keys the book-wide setting replaces. */
const NUMBERED_FORMATS = ["docx", "html", "typst"] as const;

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
  return [
    ...QUARTO_BOOK_FORMAT_ORDER.filter((format) => (
      format === "pdf" ? keys.has("typst") || keys.has("pdf") : keys.has(format)
    )),
    ...[...keys].filter((key) => !["docx", "html", "pdf", "typst"].includes(key)),
  ];
}

export function isQuartoFormatName(value: string): boolean {
  return /^(?:[A-Za-z0-9][A-Za-z0-9_-]*\/)?[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(value);
}

export function getQuartoRenderFormats(source: string): QuartoRenderFormat[] {
  const root = parseYamlRoot(source);
  const keys = new Set(readFormatKeys(root.format));
  return [
    ...QUARTO_RENDER_FORMAT_ORDER.filter((format) => keys.has(format)),
    ...[...keys].filter((key) => !(QUARTO_RENDER_FORMAT_ORDER as readonly string[]).includes(key)),
  ].filter(isQuartoFormatName);
}

function updateManagedFormats(
  document: Document,
  currentValue: unknown,
  formats: QuartoBookFormat[],
  extensionFormats: string[],
): void {
  const selected = new Set(formats);
  const selectedKeys: QuartoRenderFormat[] = formats.map(
    (format) => format === "pdf" ? "typst" : format,
  );

  if (!isRecord(currentValue)) {
    const preservedUnknownKeys = readFormatKeys(currentValue).filter(
      (key) => !["docx", "html", "pdf", "typst", ...extensionFormats].includes(key),
    );
    const next: Record<string, unknown> = {};
    for (const key of preservedUnknownKeys) next[key] = {};
    for (const key of selectedKeys) next[key] = {};
    document.set("format", document.createNode(next));
    return;
  }

  for (const format of ["docx", "html"] as const) {
    if (selected.has(format)) {
      if (!(format in currentValue)) document.setIn(["format", format], {});
    } else {
      document.deleteIn(["format", format]);
    }
  }

  if (selected.has("pdf")) {
    if (!("typst" in currentValue)) document.setIn(["format", "typst"], {});
  } else {
    document.deleteIn(["format", "typst"]);
  }
  document.deleteIn(["format", "pdf"]);
  for (const key of new Set([...extensionFormats, ...selectedKeys])) {
    if (["docx", "html", "pdf", "typst"].includes(key)) continue;
    if (selected.has(key)) {
      if (!Object.hasOwn(currentValue, key)) document.setIn(["format", key], {});
    } else {
      document.deleteIn(["format", key]);
    }
  }
}

function formatMapping(root: Record<string, unknown>, format: string): Record<string, unknown> {
  const formats = root.format;
  return isRecord(formats) && isRecord(formats[format]) ? formats[format] : {};
}

/** Like Quarto, a format's own value wins over the top-level one. */
function readFormatOption(
  root: Record<string, unknown>,
  formats: readonly string[],
  key: string,
): unknown {
  for (const format of formats) {
    const options = formatMapping(root, format);
    if (Object.hasOwn(options, key)) return options[key];
  }
  return root[key];
}

function readBookOptions(root: Record<string, unknown>): QuartoBookOptions {
  const book = readMapping(root, "book");
  const docx = formatMapping(root, "docx");
  const numbered = readFormatOption(root, NUMBERED_FORMATS, "number-sections") !== false;
  const depth = readFormatOption(root, NUMBERED_FORMATS, "number-depth");
  const crossref = isRecord(docx.crossref) && Object.hasOwn(docx.crossref, "chapters")
    ? docx.crossref
    : isRecord(root.crossref) ? root.crossref : {};
  const toc = Object.hasOwn(docx, "toc") ? docx.toc : root.toc;
  const referenceDoc = docx["reference-doc"];
  const paperSize = readFormatOption(root, ["typst"], "papersize");

  return {
    subtitle: readString(book.subtitle, ""),
    sectionNumbering: !numbered ? "none" : depth === 1 ? "chapters" : "all",
    linkCitations: root["link-citations"] === true,
    // Quarto gives Word books a table of contents unless `toc` is false.
    docxToc: toc !== false,
    docxFigureNumbering: crossref.chapters === false ? "continuous" : "chapter",
    docxReferenceDoc: typeof referenceDoc === "string" ? referenceDoc.trim() : "",
    typstPaperSize: typeof paperSize === "string" ? paperSize.trim() : "",
  };
}

function keyName(key: unknown): unknown {
  return isScalar(key) ? key.value : key;
}

/** Sets `key`, placing a new key next to `anchor` so related settings stay together. */
function setKeyBeside(
  document: Document,
  map: YAMLMap,
  key: string,
  value: unknown,
  anchor: string,
  side: "before" | "after",
): void {
  if (map.has(key)) {
    map.set(key, value);
    return;
  }
  const index = map.items.findIndex((pair) => keyName(pair.key) === anchor);
  const pair = document.createPair(key, value);
  if (index < 0) map.items.push(pair);
  else map.items.splice(side === "before" ? index : index + 1, 0, pair);
}

/** A selected format's mapping; `docx: default` becomes a mapping so options can be added. */
function formatOptionsNode(document: Document, format: string): YAMLMap {
  const node = document.getIn(["format", format], true);
  if (isMap(node)) return node;
  // An entry set earlier in this build is still a plain object, not a YAML node.
  const mapping = document.createNode(isRecord(node) && !isNode(node) ? node : {}) as YAMLMap;
  document.setIn(["format", format], mapping);
  return mapping;
}

function applyBookOptions(
  document: Document,
  root: Record<string, unknown>,
  options: QuartoBookOptions,
  formats: QuartoBookFormat[],
): void {
  const rootMap = document.contents as YAMLMap;
  const book = document.getIn(["book"], true) as YAMLMap;
  const subtitle = options.subtitle.trim();
  if (subtitle) setKeyBeside(document, book, "subtitle", subtitle, "title", "after");
  else book.delete("subtitle");

  if (options.linkCitations) setKeyBeside(document, rootMap, "link-citations", true, "format", "before");
  else rootMap.delete("link-citations");

  // Numbering is book-wide, so per-format copies would override the choice.
  for (const format of NUMBERED_FORMATS) {
    const node = document.getIn(["format", format], true);
    if (!isMap(node)) continue;
    node.delete("number-sections");
    if (options.sectionNumbering === "chapters" || node.get("number-depth") === 1) {
      node.delete("number-depth");
    }
  }
  setKeyBeside(
    document,
    rootMap,
    "number-sections",
    options.sectionNumbering !== "none",
    "format",
    "before",
  );
  if (options.sectionNumbering === "chapters") {
    setKeyBeside(document, rootMap, "number-depth", 1, "format", "before");
  } else if (options.sectionNumbering === "all" && root["number-depth"] === 1) {
    rootMap.delete("number-depth");
  }

  if (formats.includes("docx")) {
    const docx = formatOptionsNode(document, "docx");
    docx.set("toc", options.docxToc);

    const crossref = docx.get("crossref", true);
    const inheritsContinuous = isRecord(root.crossref) && root.crossref.chapters === false;
    if (options.docxFigureNumbering === "continuous" || inheritsContinuous) {
      const mapping = isMap(crossref) ? crossref : document.createNode({}) as YAMLMap;
      mapping.set("chapters", options.docxFigureNumbering === "chapter");
      docx.set("crossref", mapping);
    } else if (isMap(crossref)) {
      crossref.delete("chapters");
      if (crossref.items.length === 0) docx.delete("crossref");
    }

    if (options.docxReferenceDoc) docx.set("reference-doc", options.docxReferenceDoc);
    else docx.delete("reference-doc");
  }

  if (formats.includes("pdf")) {
    const typst = formatOptionsNode(document, "typst");
    if (options.typstPaperSize) typst.set("papersize", options.typstPaperSize);
    else typst.delete("papersize");
  }
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
      options: { ...DEFAULT_QUARTO_BOOK_OPTIONS },
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
    options: readBookOptions(root),
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
  const formats = input.formats.filter(isQuartoFormatName);

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

  const options = input.options
    ?? (existingSource ? readBookOptions(rootValue) : DEFAULT_QUARTO_BOOK_OPTIONS);
  if (
    formats.includes("docx")
    && options.docxReferenceDoc
    && (!isSafeRelativePath(options.docxReferenceDoc)
      || !options.docxReferenceDoc.toLowerCase().endsWith(".docx"))
  ) {
    throw new Error("Choose a valid Word template (.docx).");
  }
  if (
    formats.includes("pdf")
    && options.typstPaperSize
    && !/^[a-z0-9][a-z0-9-]*$/i.test(options.typstPaperSize)
  ) {
    throw new Error("Choose a valid PDF paper size.");
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
  // Resolve citations before Typst so adjacent Korean particles cannot become part of a label.
  document.set("citeproc", true);
  updateManagedFormats(document, rootValue.format, formats, input.extensionFormats ?? []);
  applyBookOptions(document, rootValue, options, formats);

  return document.toString({ lineWidth: 0 });
}
