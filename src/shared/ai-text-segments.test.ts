import { expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { protectSelectionSlice, restoreProtectedSelection, protectedRewritePreview } from "./ai-text-protection";
import { editableSegments, resolveInlineEditResponse, streamingSegmentPreview } from "./ai-text-segments";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
    citation: { group: "inline", inline: true, atom: true, attrs: { citekey: { default: "" }, locator: { default: "" } } },
  },
  marks: { bold: {} },
});

function selection() {
  const paragraph = schema.nodes.paragraph.create(null, [
    schema.text("A name that can be neither defined "),
    schema.text("nor discarded", [schema.marks.bold.create()]),
    schema.text(" deserves study "),
    schema.nodes.citation.create({ citekey: "healy2006" }),
    schema.text(" [see @smith2020] today."),
  ]);
  const doc = schema.nodes.doc.create(null, [paragraph]);
  return protectSelectionSlice(doc.slice(1, doc.content.size - 1), paragraph.textContent, "t");
}

test("a JSON answer rebuilds the passage with every citation, mark and literal kept", () => {
  const protection = selection();
  const segments = editableSegments([protection]);
  const answer = "Here you go:\n```json\n" + JSON.stringify({ edits: [
    { id: segments[0].id, text: "A term that can be neither defined " },
    { id: segments.at(-1)!.id, text: segments.at(-1)!.text.replace(" today", " now⟦SP:t:L9⟧") },
  ] }) + "\n```";
  const revised = resolveInlineEditResponse(answer, protection);
  const restored = restoreProtectedSelection(schema, protection, revised);
  expect(protectedRewritePreview(revised, protection)).toBe("A term that can be neither defined nor discarded deserves study [@healy2006] [see @smith2020] now.");
  // The selection slice holds the paragraph's inline nodes.
  expect(restored.content.child(1).marks.map(mark => mark.type.name)).toEqual(["bold"]);
  expect(restored.content.child(3).type.name).toBe("citation");
});

test("omitted or emptied segments stay unchanged; unknown ids and broken JSON fail without editing", () => {
  const protection = selection();
  const first = editableSegments([protection])[0].id;
  expect(resolveInlineEditResponse(JSON.stringify({ edits: [{ id: first, text: "  " }] }), protection)).toBe(protection.protectedText);
  expect(() => resolveInlineEditResponse(JSON.stringify({ edits: [{ id: "b9s9", text: "x" }] }), protection)).toThrow("unknown text segment");
  expect(() => resolveInlineEditResponse('{"edits":[{"id":"b0s0","text":"cut', protection)).toThrow("incomplete answer");
  // A legacy annotated answer is passed through for the strict marker validator.
  expect(resolveInlineEditResponse(protection.protectedText, protection)).toBe(protection.protectedText);
});

test("the live preview reads segment texts from a partial answer", () => {
  expect(streamingSegmentPreview('{"edits":[{"id":"b0s0","text":"A term \\"quoted\\" "},{"id":"b0s1","text":"and mo')).toBe('A term "quoted" and mo');
  expect(streamingSegmentPreview("⟦SP:x⟧ plain")).toBeNull();
});
