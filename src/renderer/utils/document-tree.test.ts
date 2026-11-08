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

test('revision documents and assets use the independent revision workspace', async () => {
  const { editingProject } = await import('./document-tree');
  const project={name:'Paper',path:'/project',files:[],lastModified:0};
  const copy=editingProject(project,'/project/revisions/session/documents/chapter.scholarpen.json')!;
  expect(copy.path).toBe('/project/revisions/session');
  expect(documentRelativeFilename(copy.path,'/project/revisions/session/documents/chapter.scholarpen.json')).toBe('chapter.scholarpen.json');
  expect(editingProject(project,'/project/revisions/session/exports/references.bib')!.path).toBe(copy.path);
  expect(editingProject(project,'/project/documents/chapter.scholarpen.json')).toBe(project);
  expect(editingProject(project,'/project/revisions/../documents/chapter.scholarpen.json')).toBe(project);
});
