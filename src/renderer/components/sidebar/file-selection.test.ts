import { describe, expect, test } from "bun:test";
import type { FileNode } from "@shared/rpc-types";
import { collectSelectableFiles, toggleFileSelection, runFileBatch } from "./file-selection";
const file = (name: string, kind: FileNode["kind"] = "note"): FileNode => ({ name, kind, path: `/project/${name}`, isDirectory: false, lastModified: 0 });
const native = file("chapter.scholarpen.json", "document");
const md = file("chapter.md");
const qmd = file("CHAPTER.QMD", "export");
const folder: FileNode = { ...file("folder", "folder"), isDirectory: true, children: [native, md, qmd, file("references.bib", "reference"), file("image.png", "figure")] };
describe("mixed file selection", () => {
  test("folder selection includes native and Markdown files, excludes unrelated files and folders", () => {
    expect(collectSelectableFiles([folder])).toEqual([native, md, qmd]);
    const selected = toggleFileSelection(new Set([md.path]), folder);
    expect([...selected].sort()).toEqual([native.path, md.path, qmd.path].sort());
    expect(toggleFileSelection(selected, folder).size).toBe(0);
  });
  test("processes only supplied files in order and reports partial failures for retry", async () => {
    const visited: string[] = [];
    const result = await runFileBatch([native, md, qmd], async node => {
      visited.push(node.path);
      if (node === md) throw new Error("Permission denied");
    });
    expect(visited).toEqual([native.path, md.path, qmd.path]);
    expect(result.succeeded).toEqual([native, qmd]);
    expect(result.failed).toEqual([{ file: md, error: "Permission denied" }]);
  });
});
