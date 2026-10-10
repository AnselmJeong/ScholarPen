import { expect, test } from "bun:test";
import { mapGuidance, normalizeMap, normalizeMapEntry, textHash } from "./manuscript-map";

const source = "Chapter 2 studies 120 patients. We define burnout as chronic exhaustion. Treatment reduced symptoms.";

test("entries keep only items quoted from the document", () => {
  const entry = normalizeMapEntry({
    title: "Results", summary: "A study.",
    claims: [{ text: "Treatment helps", quote: "Treatment reduced symptoms." }, { text: "Invented", quote: "Not in the text" }],
    terms: [{ term: "burnout", definition: "chronic exhaustion", quote: "We define burnout as chronic exhaustion." }],
    numbers: [{ value: "120", context: "sample size", quote: "studies 120   patients" }],
  }, "ch2.scholarpen.json", textHash(source), source, 5);
  expect(entry.claims).toEqual([{ text: "Treatment helps", quote: "Treatment reduced symptoms." }]);
  expect(entry.terms).toHaveLength(1);
  expect(entry.numbers).toHaveLength(1);
  expect(textHash(source)).not.toBe(textHash(`${source} `));
});

test("the prompt map leaves out the document being edited and survives a round trip", () => {
  const entry = (filename: string, title: string) => normalizeMapEntry({ title, summary: `${title} summary`, claims: [], terms: [], numbers: [] }, filename, "h", null, 1);
  const map = normalizeMap(JSON.parse(JSON.stringify({ documents: { "a.scholarpen.json": entry("a.scholarpen.json", "Intro"), "b.scholarpen.json": entry("b.scholarpen.json", "Methods") } })));
  const text = mapGuidance(map, "a.scholarpen.json");
  expect(text).toContain("Methods summary");
  expect(text).not.toContain("Intro summary");
  expect(mapGuidance({ documents: {} }, null)).toBe("");
});
