import { describe, expect, test } from "bun:test";
import type { FileNode } from "@shared/rpc-types";
import {
  collectDocumentNodes,
  documentPathsWithin,
  selectedDocumentNodes,
  toggleDocumentSelection,
} from "./export-selection";

const documentNode = (name: string): FileNode => ({
  name: `${name}.scholarpen.json`,
  path: `/project/documents/${name}.scholarpen.json`,
  kind: "document",
  isDirectory: false,
  lastModified: 0,
});

const first = documentNode("01-introduction");
const second = documentNode("02-method");
const appendix = documentNode("99-appendix");
const tree: FileNode[] = [
  {
    name: "documents",
    path: "/project/documents",
    kind: "folder",
    isDirectory: true,
    lastModified: 0,
    children: [
      first,
      second,
      {
        name: "supplement",
        path: "/project/documents/supplement",
        kind: "folder",
        isDirectory: true,
        lastModified: 0,
        children: [appendix],
      },
    ],
  },
  {
    name: "references.bib",
    path: "/project/exports/references.bib",
    kind: "reference",
    isDirectory: false,
    lastModified: 0,
  },
];

describe("export selection", () => {
  test("collects document nodes in visible tree order", () => {
    expect(collectDocumentNodes(tree)).toEqual([first, second, appendix]);
  });

  test("selects and clears all documents within a folder", () => {
    const documentsFolder = tree[0];
    const selected = toggleDocumentSelection(new Set(), documentsFolder);

    expect([...selected]).toEqual(documentPathsWithin(documentsFolder));
    expect(toggleDocumentSelection(selected, documentsFolder).size).toBe(0);
  });

  test("returns selected documents in tree order rather than click order", () => {
    const selected = new Set([appendix.path, first.path]);
    expect(selectedDocumentNodes(tree, selected)).toEqual([first, appendix]);
  });
});
