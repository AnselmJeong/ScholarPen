import { expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { protectSelectionSlice, removeDiscouragedPunctuation, restoreProtectedSelection } from "./ai-text-protection";

test("turns paired em dashes into parentheses and a single one into a comma or colon", () => {
  expect(removeDiscouragedPunctuation("Lithium — the oldest agent — remains first-line."))
    .toBe("Lithium (the oldest agent) remains first-line.");
  expect(removeDiscouragedPunctuation("Lithium—the oldest agent—remains, first-line."))
    .toBe("Lithium (the oldest agent) remains, first-line.");
  expect(removeDiscouragedPunctuation("Valproate is effective acutely — but its benefit is uncertain."))
    .toBe("Valproate is effective acutely, but its benefit is uncertain.");
  expect(removeDiscouragedPunctuation("Three agents qualify — lithium, valproate and lamotrigine."))
    .toBe("Three agents qualify: lithium, valproate and lamotrigine.");
  expect(removeDiscouragedPunctuation("리튬은 — 적어도 이론상 — 효과적이다. 그러나 — 즉 근거는 약하다."))
    .toBe("리튬은 (적어도 이론상) 효과적이다. 그러나, 즉 근거는 약하다.");
});

test("turns semicolons into sentences, but keeps citation lists, quotations and literals", () => {
  expect(removeDiscouragedPunctuation("Lithium prevents relapse; valproate does not (Kim, 2019; Lee, 2020)."))
    .toBe("Lithium prevents relapse. Valproate does not (Kim, 2019; Lee, 2020).");
  expect(removeDiscouragedPunctuation("Groups: patients with mania; patients with depression; and controls."))
    .toBe("Groups: patients with mania, patients with depression, and controls.");
  expect(removeDiscouragedPunctuation('He wrote "A; B — C" in `a; b` and $x — y$.'))
    .toBe('He wrote "A; B — C" in `a; b` and $x — y$.');
  expect(removeDiscouragedPunctuation("Ranges of 1–3 and pages 10--12 stay.")).toBe("Ranges of 1–3 and pages 10--12 stay.");
});

test("applies to every restored AI rewrite without disturbing protected nodes", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "paragraph+" },
      paragraph: { content: "inline*" },
      text: { group: "inline" },
      citation: { inline: true, group: "inline", atom: true, attrs: { citekey: { default: "" } } },
    },
    marks: { bold: {} },
  });
  const paragraph = schema.nodes.paragraph.create(null, [
    schema.text("Lithium works; it is old ("),
    schema.nodes.citation.create({ citekey: "kim2019" }),
    schema.text("; "),
    schema.nodes.citation.create({ citekey: "lee2020" }),
    schema.text(") — and ", []),
    schema.text("cheap", [schema.marks.bold.create()]),
    schema.text("."),
  ]);
  const doc = schema.nodes.doc.create(null, [paragraph]);
  const selection = protectSelectionSlice(doc.slice(1, doc.content.size - 1), doc.textContent, "punct");
  const restored = restoreProtectedSelection(schema, selection, selection.protectedText);
  const texts: string[] = [];
  restored.content.descendants(node => { if (node.isText) texts.push(node.text!); });
  expect(texts).toEqual(["Lithium works. It is old (", "; ", "), and ", "cheap", "."]);
});
