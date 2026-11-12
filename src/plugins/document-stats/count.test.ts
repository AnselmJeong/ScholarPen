import { expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { countText } from "./count";
import { acceptedText } from "../../renderer/extensions/document-snapshot";

test("grapheme counts preserve decomposed Korean, combining accents and emoji sequences", () => {
  expect(countText("한".normalize("NFD")).graphemes).toBe(1);
  expect(countText("e\u0301👨‍👩‍👧‍👦").graphemes).toBe(2);
  expect(countText("alpha beta\n한국어 문장")).toMatchObject({ words: 4, eojeol: 4, paragraphs: 2 });
  expect(countText("  \n")).toMatchObject({ words: 0, eojeol: 0, paragraphs: 0 });
});

const schema = new Schema({ nodes: { doc: { content: "block*" }, paragraph: { group: "block", content: "inline*" }, codeBlock: { group: "block", content: "text*", code: true }, text: { group: "inline" }, citation: { group: "inline", inline: true, atom: true } }, marks: { insertion: {}, deletion: {}, code: {} } });
test("accepted snapshot excludes pending insertions and code; selection uses live offsets without mutating the source", () => {
  const p = schema.nodes.paragraph!;
  const doc = schema.node("doc", null, [p.create(null, [schema.text("Original "), schema.text("proposed", [schema.mark("insertion")]), schema.text("kept", [schema.mark("deletion")]), schema.node("citation")]), schema.node("codeBlock", null, [schema.text("not prose")])]);
  const before = JSON.stringify(doc.toJSON());
  expect(acceptedText(doc)).toBe("Original kept");
  expect(acceptedText(doc, 1, 9)).toBe("Original");
  expect(JSON.stringify(doc.toJSON())).toBe(before);
});
