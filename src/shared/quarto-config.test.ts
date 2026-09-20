import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import type { FileNode } from "./rpc-types";
import {
  buildQuartoBookConfig,
  collectQuartoChapterFilenames,
  findQuartoConfigNode,
  getQuartoRenderFormats,
  parseQuartoBookConfig,
  sortQuartoChapterFilenames,
} from "./quarto-config";

describe("Quarto book configuration", () => {
  test("adds an extension as the only selected format and round-trips its options and comments", () => {
    const existingYaml = `# Book layout\nformat:\n  dst-book-typst: # keep layout\n    papersize: jis-b5\n    toc: true\n  docx: default\n`;
    const values = parseQuartoBookConfig(existingYaml, []);
    expect(values.formats).toEqual(["docx", "dst-book-typst"]);
    const yaml = buildQuartoBookConfig({
      ...values, title: "Book", authors: ["Author"], cslFilename: "style.csl",
      qmdFilenames: ["index.qmd"], formats: ["dst-book-typst"],
      extensionFormats: ["dst-book-typst"], existingYaml,
    });
    expect(parse(yaml).format).toEqual({ "dst-book-typst": { papersize: "jis-b5", toc: true } });
    expect(parse(yaml).citeproc).toBe(true);
    expect(yaml).toContain("# keep layout");
    expect(getQuartoRenderFormats(yaml)).toEqual(["dst-book-typst"]);
  });

  test.each(["format: docx", "format: [docx, epub]", "format:\n  docx: default"])("adds discovered formats to %s", (existingYaml) => {
    const yaml = buildQuartoBookConfig({
      ...parseQuartoBookConfig(existingYaml, []), title: "Book", authors: ["Author"],
      cslFilename: "style.csl", qmdFilenames: ["index.qmd"],
      formats: ["docx", "dst-book-typst"], extensionFormats: ["dst-book-typst"], existingYaml,
    });
    expect(parse(yaml).format["dst-book-typst"]).toEqual({});
    expect(getQuartoRenderFormats(yaml)).toContain("dst-book-typst");
  });

  test("removes a deselected extension while preserving unrelated formats", () => {
    const existingYaml = "format:\n  dst-book-typst: default\n  epub: {toc: true}\n";
    const yaml = buildQuartoBookConfig({
      ...parseQuartoBookConfig(existingYaml, []), title: "Book", authors: ["Author"],
      cslFilename: "style.csl", qmdFilenames: ["index.qmd"],
      formats: ["html"], extensionFormats: ["dst-book-typst"], existingYaml,
    });
    expect(parse(yaml).format).toEqual({ html: {}, epub: { toc: true } });
  });

  test("renders custom and namespaced configured formats without accepting CLI options or paths", () => {
    expect(getQuartoRenderFormats("format: [docx, dst-book-typst, org/journal-pdf, pdf, '--help', '../file']"))
      .toEqual(["docx", "dst-book-typst", "org/journal-pdf", "pdf"]);
  });

  test("pins index first and naturally sorts the remaining QMD filenames", () => {
    expect(sortQuartoChapterFilenames([
      "10 conclusion.qmd",
      "index.qmd",
      "2 methods.qmd",
      "02 background.qmd",
      "notes.md",
    ])).toEqual([
      "index.qmd",
      "02 background.qmd",
      "2 methods.qmd",
      "10 conclusion.qmd",
    ]);
  });

  test("collects only direct QMD children of the exports directory", () => {
    const nodes: FileNode[] = [{
      name: "exports",
      path: "/project/exports",
      kind: "export",
      isDirectory: true,
      lastModified: 0,
      children: [
        {
          name: "03 results.qmd",
          path: "/project/exports/03 results.qmd",
          kind: "note",
          isDirectory: false,
          lastModified: 0,
        },
        {
          name: "references.bib",
          path: "/project/exports/references.bib",
          kind: "reference",
          isDirectory: false,
          lastModified: 0,
        },
        {
          name: "index.qmd",
          path: "/project/exports/index.qmd",
          kind: "note",
          isDirectory: false,
          lastModified: 0,
        },
        {
          name: "_quarto.yml",
          path: "/project/exports/_quarto.yml",
          kind: "unknown",
          isDirectory: false,
          lastModified: 0,
        },
      ],
    }];

    expect(collectQuartoChapterFilenames(nodes)).toEqual([
      "index.qmd",
      "03 results.qmd",
    ]);
    expect(findQuartoConfigNode(nodes)?.path).toBe("/project/exports/_quarto.yml");
  });

  test("reads the current title, authors, CSL, bibliography, and chapter order", () => {
    const yaml = `project:
  type: book
  output-dir: _book
book:
  title: Placebo Effects in Neuromodulation Therapies
  author:
    - Anselm Jeong
  language: ko
  chapters:
    - index.qmd
    - 03 History.qmd
    - 02 Background.qmd
bibliography: references.bib
csl: schizophrenia_korean.csl
format:
  docx:
    toc: false
`;

    expect(parseQuartoBookConfig(yaml, [
      "index.qmd",
      "02 Background.qmd",
      "03 History.qmd",
      "unused.qmd",
    ])).toEqual({
      title: "Placebo Effects in Neuromodulation Therapies",
      authors: ["Anselm Jeong"],
      cslFilename: "schizophrenia_korean.csl",
      qmdFilenames: ["index.qmd", "03 History.qmd", "02 Background.qmd"],
      language: "ko",
      outputDir: "_book",
      bibliographyFiles: ["references.bib"],
      formats: ["docx"],
    });
  });

  test("produces valid YAML with portable book resources", () => {
    const yaml = buildQuartoBookConfig({
      title: "A Title: With Punctuation",
      authors: ["Ada Lovelace", "Alan Turing"],
      cslFilename: "journal-style.csl",
      qmdFilenames: ["10 conclusion.qmd", "index.qmd", "02 methods.qmd"],
      language: "ko",
      outputDir: "_book",
      bibliographyFiles: ["references.bib"],
      formats: ["docx", "html", "pdf"],
    });
    const parsed = parse(yaml);

    expect(parsed.project).toEqual({ type: "book", "output-dir": "_book" });
    expect(parsed.book).toEqual({
      title: "A Title: With Punctuation",
      author: ["Ada Lovelace", "Alan Turing"],
      language: "ko",
      chapters: ["10 conclusion.qmd", "index.qmd", "02 methods.qmd"],
    });
    expect(parsed.bibliography).toBe("references.bib");
    expect(parsed.csl).toBe("journal-style.csl");
    expect(parsed.citeproc).toBe(true);
    expect(parsed.format.docx).toEqual({
      toc: false,
      "number-sections": true,
    });
    expect(parsed.format.html).toEqual({});
    expect(parsed.format.typst).toEqual({});
    expect(parsed.format.pdf).toBeUndefined();
  });

  test("updates editable fields without discarding other Quarto options or comments", () => {
    const existingYaml = `# Keep this project note
project:
  type: book
  output-dir: old-book
  preview:
    port: 4321
book:
  title: Old title
  author: Old author
  chapters:
    - index.qmd
  cover-image: cover.png
bibliography: references.bib
csl: old.csl
citeproc: false
format:
  docx:
    toc: false
  html:
    theme: cosmo
`;

    const yaml = buildQuartoBookConfig({
      title: "New title",
      authors: ["First Author", "Second Author"],
      cslFilename: "new.csl",
      qmdFilenames: ["02 methods.qmd", "index.qmd"],
      language: "en",
      outputDir: "rendered-book",
      bibliographyFiles: ["references.bib", "additional.bib"],
      formats: ["html", "pdf"],
      existingYaml,
    });
    const parsed = parse(yaml);

    expect(yaml).toContain("# Keep this project note");
    expect(parsed.project.preview).toEqual({ port: 4321 });
    expect(parsed.book["cover-image"]).toBe("cover.png");
    expect(parsed.book.chapters).toEqual(["02 methods.qmd", "index.qmd"]);
    expect(parsed.bibliography).toEqual(["references.bib", "additional.bib"]);
    expect(parsed.citeproc).toBe(true);
    expect(parsed.format).toEqual({
      html: { theme: "cosmo" },
      typst: {},
    });
  });

  test("maps the editor PDF option to Typst and exposes renderable formats", () => {
    const existingYaml = `format:
  docx:
    toc: true
  html:
    theme: cosmo
  typst:
    papersize: a4
`;

    expect(parseQuartoBookConfig(existingYaml, []).formats).toEqual([
      "docx",
      "html",
      "pdf",
    ]);
    expect(getQuartoRenderFormats(existingYaml)).toEqual(["docx", "html", "typst"]);
  });

  test("preserves selected format options and unrelated custom formats", () => {
    const existingYaml = `format:
  docx:
    toc: true
  html:
    theme: cosmo
  typst:
    papersize: a4
  epub:
    toc: false
`;
    const yaml = buildQuartoBookConfig({
      title: "Formats",
      authors: ["Author"],
      cslFilename: "style.csl",
      qmdFilenames: ["index.qmd"],
      language: "en",
      outputDir: "_book",
      bibliographyFiles: ["references.bib"],
      formats: ["html", "pdf"],
      existingYaml,
    });
    const parsed = parse(yaml);

    expect(parsed.format).toEqual({
      html: { theme: "cosmo" },
      typst: { papersize: "a4" },
      epub: { toc: false },
    });
  });
});
