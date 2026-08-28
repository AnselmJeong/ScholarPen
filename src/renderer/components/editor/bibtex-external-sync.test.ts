import { describe, expect, test } from "bun:test";
import { decideExternalBibtexSync } from "./bibtex-external-sync";

describe("external bibliography synchronization", () => {
  test("reloads a clean editor from an externally changed file", () => {
    expect(decideExternalBibtexSync("old", "external", false)).toBe("reload");
  });

  test("does not discard unsaved entry edits", () => {
    expect(decideExternalBibtexSync("old", "external", true)).toBe("conflict");
  });

  test("ignores watcher events when the disk content did not change", () => {
    expect(decideExternalBibtexSync("same", "same", true)).toBe("unchanged");
  });
});
