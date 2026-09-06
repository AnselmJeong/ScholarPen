import { describe, expect, test } from "bun:test";
import type { FileNode } from "@shared/rpc-types";
import { findBibliographyNode, collectSearchDocumentNodes, documentRelativeFilename } from "./document-tree";

describe("document tree", () => {
  test("finds the canonical bibliography inside the exports folder", () => {
    const bibliography: FileNode = {
      name: "references.bib",
      path: "/project/exports/references.bib",
      kind: "reference",
      isDirectory: false,
      lastModified: 123,
    };
    const tree: FileNode[] = [{
      name: "exports",
      path: "/project/exports",
      kind: "export",
      isDirectory: true,
      lastModified: 123,
      children: [
        {
          name: "other.bib",
          path: "/project/exports/other.bib",
          kind: "reference",
          isDirectory: false,
          lastModified: 123,
        },
        bibliography,
      ],
    }];

    expect(findBibliographyNode(tree)).toBe(bibliography);
  });

  test("ignores noncanonical bibliographies in draft folders", () => {
    const draftBibliography: FileNode = {
      name: "references.bib",
      path: "/project/drafts/concept/references.bib",
      kind: "reference",
      isDirectory: false,
      lastModified: 123,
    };
    const canonicalBibliography: FileNode = {
      name: "references.bib",
      path: "/project/exports/references.bib",
      kind: "reference",
      isDirectory: false,
      lastModified: 123,
    };
    const tree: FileNode[] = [
      {
        name: "drafts",
        path: "/project/drafts",
        kind: "folder",
        isDirectory: true,
        lastModified: 123,
        children: [{
          name: "concept",
          path: "/project/drafts/concept",
          kind: "folder",
          isDirectory: true,
          lastModified: 123,
          children: [draftBibliography],
        }],
      },
      {
        name: "exports",
        path: "/project/exports",
        kind: "export",
        isDirectory: true,
        lastModified: 123,
        children: [canonicalBibliography],
      },
    ];

    expect(findBibliographyNode(tree)).toBe(canonicalBibliography);
  });

  test("returns null when references.bib is absent", () => {
    expect(findBibliographyNode([])).toBeNull();
  });
});


test("searches native documents only inside documents, retaining nested paths", () => {
  const file = (path: string): FileNode => ({ name: path.split("/").at(-1)!, path, kind: "document", isDirectory: false, lastModified: 0 });
  const nested = file("/project/documents/chapter/a.scholarpen.json");
  const root = file("/project/documents/a.scholarpen.json");
  const folder = (path: string, children: FileNode[]): FileNode => ({ ...file(path), isDirectory: true, children });
  const tree = [folder("/project/documents", [root, file("/project/documents/a.json"),
    folder("/project/documents/chapter", [nested]), file("/project/documents/../drafts/a.scholarpen.json")]),
    folder("/project/drafts", [file("/project/drafts/a.scholarpen.json")])];
  expect(collectSearchDocumentNodes(tree, "/project")).toEqual([root, nested]);
  expect(documentRelativeFilename("/project", nested.path)).toBe("chapter/a.scholarpen.json");
});
