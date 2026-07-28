import { stringify } from "yaml";
import type { FileNode } from "./rpc-types";

export interface QuartoBookConfigInput {
  title: string;
  authors: string[];
  cslFilename: string;
  qmdFilenames: string[];
}

function isPlainFilename(filename: string): boolean {
  return Boolean(filename)
    && !filename.includes("\0")
    && !filename.includes("/")
    && !filename.includes("\\")
    && !filename.includes("..");
}

export function sortQuartoChapterFilenames(filenames: string[]): string[] {
  return [...new Set(
    filenames
      .map((filename) => filename.trim())
      .filter((filename) => isPlainFilename(filename) && filename.toLowerCase().endsWith(".qmd")),
  )].sort((left, right) => {
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

export function buildQuartoBookConfig(input: QuartoBookConfigInput): string {
  const title = input.title.trim();
  const authors = input.authors.map((author) => author.trim()).filter(Boolean);
  const chapters = sortQuartoChapterFilenames(input.qmdFilenames);
  const cslFilename = input.cslFilename.trim();

  if (!title) throw new Error("A book title is required.");
  if (authors.length === 0) throw new Error("At least one author is required.");
  if (chapters.length === 0) throw new Error("Export at least one QMD file first.");
  if (!isPlainFilename(cslFilename) || !cslFilename.toLowerCase().endsWith(".csl")) {
    throw new Error("Choose a valid CSL file.");
  }

  return stringify({
    project: {
      type: "book",
      "output-dir": "_book",
    },
    book: {
      title,
      author: authors,
      language: "ko",
      chapters,
    },
    bibliography: "references.bib",
    csl: cslFilename,
    format: {
      docx: {
        theme: "yeti",
        toc: false,
        "number-sections": false,
      },
    },
  }, {
    lineWidth: 0,
  });
}
