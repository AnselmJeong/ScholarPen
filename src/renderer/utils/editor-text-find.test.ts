import { expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { TextSelection, EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { findEditorTextMatches } from "./editor-text-find";

const schema = new Schema({
  nodes: { doc: { content: "paragraph+" }, paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" }, atom: { inline: true, group: "inline", atom: true } },
  marks: { bold: {}, link: { attrs: { href: {} } } },
});

test("annotation search maps long and repeated keys to node boundaries, not text offsets", () => {
  const refs = new Schema({ nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    figure: { group: "block", atom: true, attrs: { label: {} } },
    text: { group: "inline" },
    crossReference: { inline: true, group: "inline", atom: true, attrs: { label: {} } },
    citation: { inline: true, group: "inline", atom: true, attrs: { citekey: {} } },
  } });
  const doc = refs.node("doc", null, [refs.node("paragraph", null, [
    refs.text("before "), refs.node("crossReference", { label: "fig-repeat-repeat" }),
    refs.node("citation", { citekey: "repeat2024" }), refs.text(" after"),
  ]), refs.node("figure", { label: "fig-repeat-repeat" })]);
  const matches = findEditorTextMatches(doc, "repeat");
  expect(matches).toHaveLength(5);
  expect(matches.map((match) => match.kind)).toEqual(Array(5).fill("annotation"));
  for (const match of matches) {
    expect(match.to - match.from).toBe(doc.nodeAt(match.from)!.nodeSize);
    expect(match.snippet.slice(match.snippetOffset, match.snippetOffset + 6)).toBe("repeat");
    expect(DecorationSet.create(doc, [Decoration.node(match.from, match.to, { class: "find" })]).find()).toHaveLength(1);
  }
  expect(findEditorTextMatches(doc, "before @fig")).toHaveLength(0);
  expect(findEditorTextMatches(doc, "after")[0].from).toBe(11);
});

test("finds exact positions across marks, skips atom boundaries, and navigates each occurrence", () => {
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [
    schema.text("İ C", [schema.mark("bold")]), schema.text("CK", [schema.mark("link", { href: "CCK" })]),
    schema.text(" C"), schema.node("atom"), schema.text("CK"),
  ]), schema.node("paragraph", null, [schema.text("CCK CCK")])]);
  const matches = findEditorTextMatches(doc, "cck");
  expect(matches).toHaveLength(3);
  expect(matches[0].from).toBe(3);
  let state = EditorState.create({ doc });
  for (const match of matches) {
    state = state.apply(state.tr.setSelection(TextSelection.create(doc, match.from)));
    expect(state.doc.textBetween(state.selection.from, match.to)).toBe("CCK");
    expect(match.snippet.slice(match.snippetOffset, match.snippetOffset + 3)).toBe("CCK");
  }
});
