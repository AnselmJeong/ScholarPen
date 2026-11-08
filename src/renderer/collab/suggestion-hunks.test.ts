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
