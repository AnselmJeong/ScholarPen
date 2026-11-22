import { expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { hasProtectedTextChanges, protectSelectionSlice, readProtectedRewrite, restoreProtectedSelection } from "./ai-text-protection";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
    citation: { group: "inline", inline: true, atom: true, attrs: { citekey: { default: "" }, locator: { default: "" } } },
  },
  marks: { italic: {} },
});

/** "We report the coefficient *c* for each site [@kim2020]. See `data.csv` too." */
function passage() {
  const paragraph = schema.nodes.paragraph.create(null, [
    schema.text("We report the coefficient "),
    schema.text("c", [schema.marks.italic.create()]),
    schema.text(" for each site "),
    schema.nodes.citation.create({ citekey: "kim2020" }),
    schema.text(". See `data.csv` too."),
  ]);
  const doc = schema.nodes.doc.create(null, [paragraph]);
  return protectSelectionSlice(doc.slice(1, doc.content.size - 1), paragraph.textContent, "t");
}

const open = (index: number) => `⟦SP:t:T${index}:OPEN⟧`;
const close = (index: number) => `⟦SP:t:T${index}:CLOSE⟧`;
const CITATION = "⟦SP:t:N0:citation⟧";
const CODE = "⟦SP:t:L0⟧";

test("a rewrite may empty a formatting run or leave out a citation or literal only when the removal is declared", () => {
  const protection = passage();
  expect(protection.protectedText).toBe(`${open(0)}We report the coefficient ${close(0)}${open(1)}c${close(1)}${open(2)} for each site ${close(2)}${CITATION}${open(3)}. See ${CODE} too.${close(3)}`);
  // Deleting "the coefficient c for each site [@kim2020]" and "See `data.csv` too.".
  const response = `${open(0)}We report ${close(0)}${open(1)}${close(1)}${open(2)}${close(2)}${open(3)}.${close(3)}`;

  // A model's own rewrite never drops protected content.
  expect(() => restoreProtectedSelection(schema, protection, response)).toThrow();
  expect(() => readProtectedRewrite(protection, response)).toThrow(/omitted a protected BlockNote marker/);
  expect(() => readProtectedRewrite(protection, response, { texts: [1, 2], markers: [CITATION] })).toThrow(/omitted a protected BlockNote marker/);
  expect(() => readProtectedRewrite(protection, response, { texts: [2], markers: [CITATION, CODE] })).toThrow(/entire formatted text segment/);

  const removals = { texts: [1, 2], markers: [CITATION, CODE] };
  expect(readProtectedRewrite(protection, response, removals)).toEqual({ texts: ["We report ", "", "", "."], removedNodes: [0] });
  expect(hasProtectedTextChanges(protection, response, removals)).toBe(true);
});

test("removing only a citation is a change; declared removals that stay are kept", () => {
  const protection = passage();
  const withoutCitation = protection.protectedText.replace(CITATION, "");
  expect(hasProtectedTextChanges(protection, withoutCitation, { texts: [], markers: [CITATION] })).toBe(true);
  expect(readProtectedRewrite(protection, withoutCitation, { texts: [], markers: [CITATION] }).removedNodes).toEqual([0]);
  expect(readProtectedRewrite(protection, protection.protectedText, { texts: [1], markers: [CITATION, CODE] }))
    .toEqual({ texts: ["We report the coefficient ", "c", " for each site ", ". See `data.csv` too."], removedNodes: [] });
  expect(hasProtectedTextChanges(protection, protection.protectedText, { texts: [1], markers: [CITATION] })).toBe(false);
});
