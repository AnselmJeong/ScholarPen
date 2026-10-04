import { expect, test } from "bun:test";
import { applyHunks, diffHunks, isMinorEdit, mergeText } from "./text-diff";

test("word hunks reproduce the revision", () => {
  const base = "The results show a large effect, which proves causation.";
  const revised = "The results suggest a large effect, which is consistent with causation.";
  const hunks = diffHunks(base, revised);
  expect(applyHunks(base, hunks)).toBe(revised);
  expect(hunks.length).toBe(2);
});

test("Korean text diffs by word", () => {
  const base = "이 연구는 효과가 크다는 것을 증명한다.";
  const revised = "이 연구는 효과가 크다는 것을 시사한다.";
  expect(diffHunks(base, revised)).toEqual([{ from: 17, to: 21, insert: "시사한다" }]);
});

test("three-way merge keeps both sides when they touch different words", () => {
  const base = "Alpha beta gamma delta epsilon.";
  const user = "Alpha beta gamma delta epsilon zeta.";
  const ai = "Alpha BETA gamma delta epsilon.";
  expect(mergeText(base, user, ai)).toBe("Alpha BETA gamma delta epsilon zeta.");
  expect(mergeText(base, "Alpha bet gamma delta epsilon.", ai)).toBeNull();
});

test("minor edits are typo-sized", () => {
  const base = "We recieve teh data.";
  expect(isMinorEdit(base, diffHunks(base, "We receive the data."))).toBe(true);
  expect(isMinorEdit(base, diffHunks(base, "We obtained the full dataset."))).toBe(false);
});
