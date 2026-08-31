import { describe, expect, test } from "bun:test";
import type { FileNode } from "@shared/rpc-types";
import { findBibliographyNode } from "./document-tree";

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
