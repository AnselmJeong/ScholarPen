import { describe, expect, test } from "bun:test";
import { buildProjectFileReference, parseProjectFileReference } from "./project-file-reference";

describe("project file references", () => {
  test("round trips a project-relative path and PDF page", () => {
    const href = buildProjectFileReference("resources/articles/a paper.pdf", 7);
    expect(parseProjectFileReference(href)).toEqual({
      relativePath: "resources/articles/a paper.pdf",
      page: 7,
    });
  });

  test("rejects traversal, absolute paths, and unrelated URLs", () => {
    expect(() => buildProjectFileReference("../secret.pdf")).toThrow();
    expect(parseProjectFileReference("https://example.com/project-file?path=a.pdf")).toBeNull();
    expect(parseProjectFileReference("https://scholarpen.local/project-file?path=../a.pdf")).toBeNull();
  });
});
