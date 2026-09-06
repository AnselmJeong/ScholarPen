import { expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { TextSelection, EditorState } from "prosemirror-state";
import { findEditorTextMatches } from "./editor-text-find";

const schema = new Schema({
  nodes: { doc: { content: "paragraph+" }, paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" }, atom: { inline: true, group: "inline", atom: true } },
  marks: { bold: {}, link: { attrs: { href: {} } } },
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
