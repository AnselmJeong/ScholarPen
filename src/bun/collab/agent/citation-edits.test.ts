import { expect, test } from "bun:test";
import { applyHunks } from "./text-diff";
import { citationHunks, findCitations, rewriteCitations } from "./citation-edits";

test("finds Pandoc citation groups with locators and leaves other brackets alone", () => {
  expect(findCitations("A [@a, p. 4; @doi:10.1000/x] and [sic] and [@ bad] and [see @b].")).toEqual([
    { from: 2, to: 28, items: [{ key: "a", locator: "p. 4" }, { key: "doi:10.1000/x", locator: "" }] },
  ]);
});

test("rewrites keys and removes emptied groups with their leading space", () => {
  const map = (key: string) => key === "a" ? "smith2020" : null;
  expect(rewriteCitations("One [@a; @b], two [@b].", map)).toBe("One [@smith2020], two.");
});

test("hunks contain whole citation groups and nothing more than needed", () => {
  const original = "These findings suggest the hypothesis.";
  const revised = "These findings suggest the hypothesis [@a, p. 4].";
  const hunks = citationHunks(original, revised, key => key === "a");
  expect(hunks).toEqual([{ from: 37, to: 37, insert: " [@a, p. 4]", citations: [{ from: 1, to: 11, items: [{ key: "a", locator: "p. 4" }] }] }]);
  expect(applyHunks(original, hunks)).toBe(revised);
});

test("several edits and citations in one passage still reproduce the revision", () => {
  const original = "Early work. Results were large. Later work agrees.";
  const revised = "Early work [@a]. Results were modest [@b; @c]. Later work [@x] agrees.";
  const hunks = citationHunks(original, revised, key => key !== "x");
  expect(applyHunks(original, hunks)).toBe(revised);
  const keys = hunks.flatMap(hunk => hunk.citations.map(span => {
    expect(hunk.insert.slice(span.from, span.to)).toMatch(/^\[@.*\]$/);
    return span.items.map(item => item.key).join("+");
  }));
  expect(keys).toEqual(["a", "b+c"]); // Unknown keys stay plain text.
});
