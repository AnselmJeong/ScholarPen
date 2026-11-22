import { expect, test } from "bun:test";
import { Schema, type Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { deletion, insertion, modification } from "@handlewithcare/prosemirror-suggest-changes";
import { PENDING_NODE_MARK, pendingNodeText, settlePendingNodes } from "./pending-nodes";
import { resolveSuggestions, revertedDoc } from "./resolve-suggestions";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
    citation: { group: "inline", inline: true, atom: true, attrs: { citekey: { default: "" }, locator: { default: "" } } },
  },
  marks: {
    italic: {},
    insertion: { ...insertion, attrs: { id: { default: null } } },
    deletion: { ...deletion, attrs: { id: { default: null } } },
    modification,
    [PENDING_NODE_MARK]: { attrs: { node: { default: "" } }, inclusive: false },
  },
});

const del = (id: number) => schema.marks.deletion.create({ id });
const ins = (id: number) => schema.marks.insertion.create({ id });
const cite = (citekey: string) => schema.nodes.citation.create({ citekey });

/** Paragraphs as text, with citations spelled out and suggestions shown as [-…-] and [+…+]. */
function view(doc: PMNode) {
  const paragraphs: string[] = [];
  doc.forEach((paragraph) => {
    let out = "";
    paragraph.forEach((node) => {
      const text = node.isText ? node.text! : `⟨${node.attrs.citekey}⟩`;
      const italic = node.marks.some((mark) => mark.type.name === "italic") ? `_${text}_` : text;
      const pending = node.marks.some((mark) => mark.type.name === PENDING_NODE_MARK) ? `{${italic}}` : italic;
      out += node.marks.some((mark) => mark.type.name === "deletion") ? `[-${pending}-]`
        : node.marks.some((mark) => mark.type.name === "insertion") ? `[+${pending}+]` : pending;
    });
    paragraphs.push(out);
  });
  return paragraphs.join(" ¶ ");
}

/**
 * One change set (1) that deletes "…coefficient _c_ for each site [@kim2020]. " at the end of the first
 * paragraph (three struck pieces in a row) and the first sentence of the second, and adds a citation to it.
 */
function document() {
  return schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, [
      schema.text("Two sites were enrolled. "),
      schema.text("The coefficient ", [del(1)]),
      schema.text("c", [schema.marks.italic.create(), del(1)]),
      schema.text(" held for each site ", [del(1)]),
      pendingNodeText(cite("kim2020"), [del(1)]),
      schema.text(".", [del(1)]),
    ]),
    schema.nodes.paragraph.create(null, [
      schema.text("It was small. ", [del(1)]),
      schema.text("It was pooled", [ins(1)]),
      pendingNodeText(cite("lee2019"), [ins(1)]),
      schema.text(". The data were pooled."),
    ]),
  ]);
}

test("pending citations read as their text and are struck or added like the words around them", () => {
  expect(view(document())).toBe("Two sites were enrolled. [-The coefficient -][-_c_-][- held for each site -][-{[@kim2020]}-][-.-]"
    + " ¶ [-It was small. -][+It was pooled+][+{[@lee2019]}+]. The data were pooled.");
});

test("keeping a change set never merges paragraphs; a kept citation becomes a node", () => {
  const tr = new Transform(document());
  expect(resolveSuggestions(tr, true, 1)).toBe(true);
  expect(view(tr.doc)).toBe("Two sites were enrolled.  ¶ It was pooled⟨lee2019⟩. The data were pooled.");
  expect(tr.doc.childCount).toBe(2);
});

test("reverting brings back the italic run and the citation node and drops the added citation", () => {
  const tr = new Transform(document());
  expect(resolveSuggestions(tr, false, 1)).toBe(true);
  expect(view(tr.doc)).toBe("Two sites were enrolled. The coefficient _c_ held for each site ⟨kim2020⟩. ¶ It was small. . The data were pooled.");
  expect(view(revertedDoc(document()))).toBe(view(tr.doc));
});

test("a range resolves only the suggestions starting in it; other change sets stay", () => {
  const tr = new Transform(document());
  const second = document().child(0).nodeSize;
  // Only the second paragraph's part, as the per-paragraph Keep does it.
  expect(resolveSuggestions(tr, true, 1, { from: second, to: tr.doc.content.size })).toBe(true);
  expect(view(tr.doc)).toBe("Two sites were enrolled. [-The coefficient -][-_c_-][- held for each site -][-{[@kim2020]}-][-.-] ¶ It was pooled⟨lee2019⟩. The data were pooled.");
  expect(resolveSuggestions(new Transform(document()), true, 2)).toBe(false);
});

test("settling leaves stand-ins that are still pending alone", () => {
  const tr = new Transform(document());
  expect(settlePendingNodes(tr)).toBe(false);
  // A stand-in split by another mark is still one node.
  const split = schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, [schema.text("See "), pendingNodeText(cite("kim2020"))])]);
  const [text] = [split.child(0).child(1)];
  const mark = text.marks[0];
  const halves = schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, [
    schema.text("See "), schema.text("[@kim", [mark, schema.marks.italic.create()]), schema.text("2020]", [mark]),
  ])]);
  const settle = new Transform(halves);
  expect(settlePendingNodes(settle)).toBe(true);
  expect(view(settle.doc)).toBe("See ⟨kim2020⟩");
});
