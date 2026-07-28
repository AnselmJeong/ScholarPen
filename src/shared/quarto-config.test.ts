import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import type { FileNode } from "./rpc-types";
import {
  buildQuartoBookConfig,
  collectQuartoChapterFilenames,
  sortQuartoChapterFilenames,
} from "./quarto-config";

describe("Quarto book configuration", () => {
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
      ],
    }];

    expect(collectQuartoChapterFilenames(nodes)).toEqual([
      "index.qmd",
      "03 results.qmd",
    ]);
  });

  test("produces valid YAML with portable book resources", () => {
    const yaml = buildQuartoBookConfig({
      title: "A Title: With Punctuation",
      authors: ["Ada Lovelace", "Alan Turing"],
      cslFilename: "journal-style.csl",
      qmdFilenames: ["10 conclusion.qmd", "index.qmd", "02 methods.qmd"],
    });
    const parsed = parse(yaml);

    expect(parsed.project).toEqual({ type: "book", "output-dir": "_book" });
    expect(parsed.book).toEqual({
      title: "A Title: With Punctuation",
      author: ["Ada Lovelace", "Alan Turing"],
      language: "ko",
      chapters: ["index.qmd", "02 methods.qmd", "10 conclusion.qmd"],
    });
    expect(parsed.bibliography).toBe("references.bib");
    expect(parsed.csl).toBe("journal-style.csl");
    expect(parsed.format.docx).toEqual({
      theme: "yeti",
      toc: false,
      "number-sections": false,
    });
  });
});
