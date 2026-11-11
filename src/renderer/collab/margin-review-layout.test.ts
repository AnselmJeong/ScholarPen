import { expect, test } from "bun:test";
import { packMarginCards, hunkDecisionRange } from "./margin-review-layout";

test("dense annotations stay ordered without overlap, then recover their source alignment", () => {
  const cards = packMarginCards([
    { key: "a", anchor: 100, height: 180 },
    { key: "b", anchor: 110, height: 70 },
    { key: "c", anchor: 120, height: 140 },
    { key: "d", anchor: 900, height: 80 },
  ]);
  for (let i = 1; i < cards.length; i++) expect(cards[i].top).toBeGreaterThanOrEqual(cards[i - 1].top + cards[i - 1].height + 12);
  expect(cards[3].top).toBe(882);
  const collapsed = packMarginCards(cards.filter(card => card.key !== "a"));
  expect(collapsed[0].top).toBe(92);
});

test("compact pins and a top-of-document anchor remain reachable", () => {
  const cards = packMarginCards(Array.from({ length: 30 }, (_, i) => ({ key: String(i), anchor: i, height: 26 })), 6);
  expect(cards[0].top).toBe(0);
  for (let i = 1; i < cards.length; i++) expect(cards[i].top - cards[i - 1].top).toBe(32);
  expect(packMarginCards([])).toEqual([]);
});

test("one hunk's decision excludes the adjacent change's start", () => {
  expect(hunkDecisionRange({ from: 4, to: 15 })).toEqual({ from: 4, to: 14 });
  expect(hunkDecisionRange({ from: 4, to: 4 })).toEqual({ from: 4, to: 4 });
});
