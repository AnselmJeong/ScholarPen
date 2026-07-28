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

  test("returns null when references.bib is absent", () => {
    expect(findBibliographyNode([])).toBeNull();
  });
});
