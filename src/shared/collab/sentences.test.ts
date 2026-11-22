import { expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { applyHunks } from "./text-diff";
import { sentenceSpans } from "./sentences";
import { revisedInline, sentenceHunks, suggestReplacement } from "./suggested-edits";

const sentences = (text: string) => sentenceSpans(text).map(({ from, to }) => text.slice(from, to));

test("sentences survive citations, figures, decimals and abbreviations", () => {
  expect(sentences("Efficacy depends on charge (Sackeim et al., 1993; McCall et al., 2000). Fig. 2 shows that 1.5 mg works, e.g. in older patients. "
    + "Dr. Kim agreed. 결과는 다음과 같다. 그러나 차이는 없었다.")).toEqual([
    "Efficacy depends on charge (Sackeim et al., 1993; McCall et al., 2000).",
    "Fig. 2 shows that 1.5 mg works, e.g. in older patients.",
    "Dr. Kim agreed.",
    "결과는 다음과 같다.",
    "그러나 차이는 없었다.",
  ]);
});

const parts = (original: string, revised: string) => {
  const hunks = sentenceHunks(original, revised);
  expect(applyHunks(original, hunks)).toBe(revised);
  return hunks.map((hunk) => [original.slice(hunk.from, hunk.to), hunk.insert]);
};

test("a word changed inside a sentence replaces the whole sentence, and only that one", () => {
  expect(parts(
    "Earlier work agreed. Both the charge may the dose relative to threshold matter. Later work agreed.",
    "Earlier work agreed. Both the charge and the dose relative to threshold matter. Later work agreed.",
  )).toEqual([["Both the charge may the dose relative to threshold matter.", "Both the charge and the dose relative to threshold matter."]]);
});

test("changes in separate sentences stay separate", () => {
  expect(parts("One is big. Two is small. Three is red.", "One is large. Two is small. Three is blue.")).toEqual([
    ["One is big.", "One is large."],
    ["Three is red.", "Three is blue."],
  ]);
});

test("an added or removed sentence is a change of its own", () => {
  const added = parts("A came first. Second one followed.", "A came first. A new one came in. Second one followed.");
  expect(added).toHaveLength(1);
  expect(added[0][0]).toBe("");
  expect(added[0][1].trim()).toBe("A new one came in.");
  const removed = parts("A came first. A new one came in. Second one followed.", "A came first. Second one followed.");
  expect(removed).toHaveLength(1);
  expect(removed[0][0].trim()).toBe("A new one came in.");
  expect(removed[0][1]).toBe("");
});

test("sentences joined into one are one change", () => {
  expect(parts("The group improved. The controls did not.", "The group improved, but the controls did not.")).toEqual([
    ["The group improved. The controls did not.", "The group improved, but the controls did not."],
  ]);
});

test("a fragment without a sentence end is its own unit", () => {
  expect(parts("claim proves", "claim supports")).toEqual([["claim proves", "claim supports"]]);
  expect(parts("결과는 유의하였다. 효과가 크다.", "결과는 유의하였다. 효과가 작다.")).toEqual([["효과가 크다.", "효과가 작다."]]);
});

const schema = new Schema({
  nodes: { doc: { content: "paragraph" }, paragraph: { content: "text*" }, text: {} },
  marks: { italic: {}, aiAuthored: {} },
});

test("kept words keep their own marks; only the AI's words carry its authorship", () => {
  const italic = schema.marks.italic.create();
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [
    schema.text("The "), schema.text("drug", [italic]), schema.text(" may reduce pain."),
  ])]);
  const original = "The drug may reduce pain.";
  const nodes = revisedInline(doc, 1, original, "The drug clearly reduces chronic pain.", []);
  expect(nodes.map((node) => node.text).join("")).toBe("The drug clearly reduces chronic pain.");
  expect(nodes.map((node) => [node.text, node.marks.map((mark) => mark.type.name).join(",")])).toEqual([
    ["The ", ""], ["drug", "italic"], [" ", ""],
    // The space between two new stretches is part of the AI's wording.
    ["clearly reduces", "aiAuthored"], [" ", "aiAuthored"], ["chronic", "aiAuthored"],
    [" pain.", ""],
  ]);
});

test("a sentence that ends a paragraph keeps its new wording in that paragraph", () => {
  const marked = new Schema({
    nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} },
    marks: { insertion: { attrs: { id: {} }, inclusive: false }, deletion: { attrs: { id: {} }, inclusive: false } },
  });
  const doc = marked.node("doc", null, [
    marked.node("paragraph", null, [marked.text("A strong claim.")]),
    marked.node("paragraph", null, [marked.text("Another strong claim.")]),
  ]);
  const tr = EditorState.create({ doc }).tr;
  // Later paragraphs first, as edits are applied from the end; one change set for both.
  suggestReplacement(tr, 18, 39, [marked.text("Another qualified claim.")], 1);
  suggestReplacement(tr, 1, 16, [marked.text("A qualified claim.")], 1);
  const paragraphs: string[][] = [];
  tr.doc.forEach((paragraph) => {
    const parts: string[] = [];
    paragraph.forEach((node) => parts.push(`${node.marks.map((mark) => mark.type.name).join(",")}:${node.text}`));
    paragraphs.push(parts);
  });
  expect(paragraphs).toEqual([
    ["deletion:A strong claim.", "insertion:A qualified claim."],
    ["deletion:Another strong claim.", "insertion:Another qualified claim."],
  ]);
});
