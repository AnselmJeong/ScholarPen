import { expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import { protectSelectionSlice, restoreProtectedSelection } from "../../../shared/ai-text-protection";
import { editableSegments, parseTextEdits } from "./text-edits";

const schema = new Schema({ nodes: {
  doc: { content: "paragraph+" }, paragraph: { content: "inline*" }, text: { group: "inline" },
  citation: { group: "inline", inline: true, atom: true, attrs: { citekey: {} } },
}, marks: { bold: {}, italic: {}, link: { attrs: { href: {} } } } });
const content = schema.node("paragraph", null, [
  schema.text("Earlier findings ", [schema.marks.bold.create()]),
  schema.node("citation", { citekey: "smith2026" }),
  schema.text(" suggest $x^2$ and [@doe2025] may help. "),
  schema.text("Read more", [schema.marks.link.create({ href: "https://example.com" })]),
]);
const source = protectSelectionSlice(content.slice(0), content.textContent);
const slots = editableSegments([source]).map(({ id, text }) => ({ id, text }));
const response = (edits: unknown) => JSON.stringify({ reply: "Updated wording.", edits });

test("text-only protocol reconstructs every marker, citation, literal and rich-text mark on the host", () => {
  const parsed = parseTextEdits(response(slots.map(slot => ({ ...slot, text: slot.text.replace("Earlier", "Previous") }))), [source])!;
  const restored = restoreProtectedSelection(schema, source, parsed.parts![0]);
  expect(restored.content.firstChild?.text).toBe("Previous findings ");
  expect(restored.content.firstChild?.marks[0].type.name).toBe("bold");
  expect(restored.content.child(1).attrs.citekey).toBe("smith2026");
  expect(restored.content.child(2).text).toBe(" suggest $x^2$ and [@doe2025] may help. ");
  expect(restored.content.lastChild?.marks[0].attrs.href).toBe("https://example.com");
  expect(slots.map(slot => slot.text).join("")).not.toContain("$x^2$");
  expect(slots.map(slot => slot.text).join("")).not.toContain("[@doe2025]");
});

test("missing, duplicate, unknown, empty, and truncated segments are rejected", () => {
  for (const edits of [slots.slice(1), [...slots, slots[0]], [...slots, { id: "bogus", text: "hi" }],
    slots.map((slot, i) => i ? slot : { ...slot, text: "" }),
    slots.map((slot, i) => i ? slot : { ...slot, text: "⟦SP:forged⟧" })]) {
    expect(() => parseTextEdits(response(edits), [source])).toThrow();
  }
  expect(() => parseTextEdits(response(slots).slice(0, -10), [source])).toThrow();
});

test("segment order in JSON is irrelevant; it cannot move paragraphs or formatting", () => {
  const parsed = parseTextEdits(response([...slots].reverse()), [source])!;
  expect(parsed.parts).toEqual([source.protectedText]);
  expect(parseTextEdits('<reply>ok</reply><passage>NO_CHANGE</passage>', [source])).toBeNull();
});
