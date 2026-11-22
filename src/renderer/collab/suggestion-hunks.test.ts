import { expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { hunkSignature, listHunks } from "./suggestion-hunks";

// The shape BlockNote gives the document: blockContainer > paragraph > text.
const schema = new Schema({
  nodes: {
    doc: { content: "blockContainer+" },
    blockContainer: { content: "paragraph", attrs: { id: { default: null } } },
    paragraph: { content: "text*", group: "block" },
    text: {},
  },
  marks: {
    insertion: { attrs: { id: {} }, inclusive: false },
    deletion: { attrs: { id: {} }, inclusive: false },
  },
});

const ins = (text: string, id: number) => schema.text(text, [schema.marks.insertion.create({ id })]);
const del = (text: string, id: number) => schema.text(text, [schema.marks.deletion.create({ id })]);
const plain = (text: string) => schema.text(text);
const block = (id: string, ...content: ReturnType<typeof plain>[]) =>
  schema.nodes.blockContainer.create({ id }, schema.nodes.paragraph.create(null, content));

test("adjacent removed and added text of one request is one change", () => {
  const doc = schema.nodes.doc.create(null, [
    block("a", del("I just wanted to ask if we could maybe", 1), ins("Can we", 1), plain(" move the review? I know it's"),
      del(" a bit", 1), plain(" late.")),
    block("b", plain("Thanks"), del(" so much", 1), plain(",")),
  ]);
  const hunks = listHunks(doc);
  expect(hunks.map(({ blockId, deleted, inserted }) => ({ blockId, deleted, inserted }))).toEqual([
    { blockId: "a", deleted: "I just wanted to ask if we could maybe", inserted: "Can we" },
    { blockId: "a", deleted: " a bit", inserted: "" },
    { blockId: "b", deleted: " so much", inserted: "" },
  ]);
  const [first] = hunks;
  expect(doc.textBetween(first.insertions[0].from, first.insertions[0].to)).toBe("Can we");
  expect(doc.textBetween(first.deletions[0].from, first.deletions[0].to)).toBe("I just wanted to ask if we could maybe");
  expect(first.to).toBe(first.insertions[0].to);
});

test("changes from different requests or paragraphs stay apart", () => {
  const doc = schema.nodes.doc.create(null, [
    block("a", ins("one", 1), ins("two", 2)),
    block("b", ins("three", 2)),
  ]);
  const hunks = listHunks(doc);
  expect(hunks.map((hunk) => [hunk.id, hunk.inserted])).toEqual([[1, "one"], [2, "two"], [2, "three"]]);
  expect(new Set(hunks.map(hunkSignature)).size).toBe(3);
});

test("a document without suggestions has no changes", () => {
  expect(listHunks(schema.nodes.doc.create(null, [block("a", plain("Clean text."))]))).toEqual([]);
});

test("word-level changes inside one sentence are one change, shown as the whole sentence before and after", () => {
  const doc = schema.nodes.doc.create(null, [
    block("a", plain("Earlier work agreed. Both the charge "), del("may", 1), ins("and", 1), plain(" the dose "),
      del("is", 1), ins("are", 1), plain(" relevant. Later work agreed.")),
  ]);
  const hunks = listHunks(doc);
  expect(hunks).toHaveLength(1);
  const [hunk] = hunks;
  expect(hunk).toMatchObject({
    id: 1, blockId: "a", deleted: "mayis", inserted: "andare",
    before: "Both the charge may the dose is relevant.",
    after: "Both the charge and the dose are relevant.",
  });
  expect(hunk.insertions).toHaveLength(2);
  expect(hunk.deletions).toHaveLength(2);
  // The sentence's range in the document, both versions included, for highlighting it.
  expect(doc.textBetween(hunk.span.from, hunk.span.to)).toBe("Both the charge mayand the dose isare relevant.");
  // Deciding the change covers every suggested run of the sentence and nothing outside it.
  expect(doc.textBetween(hunk.from, hunk.to)).toBe("mayand the dose isare");
});

test("an added or removed sentence has no other side", () => {
  const doc = schema.nodes.doc.create(null, [
    block("a", plain("First one. "), ins("A new sentence. ", 3), plain("Second one."), del(" Gone now.", 3)),
  ]);
  expect(listHunks(doc).map(({ before, after }) => ({ before, after }))).toEqual([
    { before: "", after: "A new sentence." },
    { before: "Gone now.", after: "" },
  ]);
});
