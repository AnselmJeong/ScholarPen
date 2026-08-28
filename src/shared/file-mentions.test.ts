import { describe, expect, test } from "bun:test";
import {
  findActiveFileMention,
  formatFileMention,
  parseFileMentions,
  replaceActiveFileMention,
} from "./file-mentions";

describe("file mention syntax", () => {
  test("keeps spaces in an active file search query", () => {
    expect(findActiveFileMention("Compare @03 History of Neuro")).toEqual({
      start: 8,
      query: "03 history of neuro",
    });
  });

  test("inserts an unambiguous project-relative path", () => {
    expect(
      replaceActiveFileMention(
        "Compare @03 History",
        "exports/03 History of Neuromodulation.qmd",
      ),
    ).toBe("Compare @[exports/03 History of Neuromodulation.qmd] ");
  });

  test("does not reopen autocomplete for a completed mention", () => {
    const mention = formatFileMention("documents/03 History of Neuromodulation.scholarpen.json");
    expect(findActiveFileMention(`Compare ${mention} `)).toBeNull();
  });

  test("parses bracketed, quoted, and legacy mentions", () => {
    expect(
      parseFileMentions(
        'Use @[exports/03 History of Neuromodulation.qmd] and @"documents/01 Introduction.scholarpen.json" plus @notes.md',
      ),
    ).toEqual([
      { value: "exports/03 History of Neuromodulation.qmd", syntax: "bracketed" },
      { value: "documents/01 Introduction.scholarpen.json", syntax: "quoted" },
      { value: "notes.md", syntax: "legacy" },
    ]);
  });

  test("round-trips closing brackets and backslashes in paths", () => {
    const mention = formatFileMention(String.raw`exports/a]b\\draft.qmd`);
    expect(parseFileMentions(mention)[0]?.value).toBe(String.raw`exports/a]b\\draft.qmd`);
  });
});
