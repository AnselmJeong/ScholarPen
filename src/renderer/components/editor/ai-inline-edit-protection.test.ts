import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";
import {
  buildInlineEditDocumentContext,
  buildInlineEditMessages,
  protectSelectionSlice,
  restoreProtectedSelection,
} from "./ai-inline-edit-protection";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
    citation: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { citekey: { default: "" }, locator: { default: "" } },
    },
  },
  marks: {
    bold: {},
    italic: {},
  },
});

function makeProtectedSelection(selectedText = "원문 인용 강조") {
  const bold = schema.marks.bold.create();
  const italic = schema.marks.italic.create();
  const paragraph = schema.nodes.paragraph.create(null, [
    schema.text("원문 ", [bold]),
    schema.nodes.citation.create({ citekey: "kim2025", locator: "p. 7" }),
    schema.text(" **강조**", [italic]),
  ]);
  const doc = schema.nodes.doc.create(null, [paragraph]);
  const slice = doc.slice(1, doc.content.size - 1);
  return protectSelectionSlice(slice, selectedText, "testselection");
}

describe("AI inline edit protection", () => {
  test("keeps Korean rewrites in Korean unless translation is requested", () => {
    const selection = makeProtectedSelection();
    const messages = buildInlineEditMessages("Improve the writing quality", selection);

    expect(messages.system).toContain("source passage is Korean");
    expect(messages.system).toContain("Write the replacement in Korean");
  });

  test("keeps English rewrites in English unless translation is requested", () => {
    const selection = makeProtectedSelection("Improve this English sentence.");
    const messages = buildInlineEditMessages("Shorten", selection);

    expect(messages.system).toContain("source passage is English");
    expect(messages.system).toContain("Write the replacement in English");
  });

  test("uses the complete manuscript to polish style and surface internal contradictions", () => {
    const selection = makeProtectedSelection();
    const messages = buildInlineEditMessages(
      "Polish this passage as academic prose",
      selection,
      {
        beforeSelection: "The introduction defines the paper's central problem.",
        afterSelection: "The conclusion returns to the same qualified claim.",
      }
    );

    expect(messages.system).toContain("Polish its academic style");
    expect(messages.system).toContain("internal contradictions");
    expect(messages.system).toContain("make the tension or uncertainty explicit");
    expect(messages.system).not.toContain("web-verification");
    expect(messages.user).toContain("<complete_document_context reference_only=\"true\">");
    expect(messages.user).toContain("The introduction defines the paper's central problem.");
    expect(messages.user).toContain("The conclusion returns to the same qualified claim.");
    expect(messages.user).toContain(selection.protectedText);
  });

  test("captures all document text before and after the selected passage", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, schema.text("Introduction context")),
      schema.nodes.paragraph.create(null, schema.text("Selected claim")),
      schema.nodes.paragraph.create(null, schema.text("Conclusion context")),
    ]);
    let from = 0;
    let to = 0;
    doc.descendants((node, pos) => {
      if (node.isText && node.text === "Selected claim") {
        from = pos;
        to = pos + node.nodeSize;
      }
    });

    const context = buildInlineEditDocumentContext(doc, from, to);
    expect(context.beforeSelection).toContain("Introduction context");
    expect(context.beforeSelection).not.toContain("Selected claim");
    expect(context.afterSelection).toContain("Conclusion context");
    expect(context.afterSelection).not.toContain("Selected claim");
  });

  test("restores rewritten text without losing marks, citations, or Markdown controls", () => {
    const selection = makeProtectedSelection();
    expect(selection.protectedText).not.toContain("**");

    const response = selection.protectedText
      .replace("원문", "개선된 원문")
      .replace("강조", "핵심 표현");
    const restored = restoreProtectedSelection(schema, selection, response);
    const content = restored.content.toJSON();

    expect(content).toEqual([
      { type: "text", marks: [{ type: "bold" }], text: "개선된 원문 " },
      { type: "citation", attrs: { citekey: "kim2025", locator: "p. 7" } },
      { type: "text", marks: [{ type: "italic" }], text: " **핵심 표현**" },
    ]);
  });

  test("rejects a response that drops a protected citation marker", () => {
    const selection = makeProtectedSelection();
    const citationMarker = selection.markers.find((marker) => marker.kind === "node");
    expect(citationMarker).toBeDefined();

    const unsafeResponse = selection.protectedText.replace(citationMarker!.token, "");
    expect(() => restoreProtectedSelection(schema, selection, unsafeResponse)).toThrow(
      "changed or omitted a protected BlockNote marker"
    );
  });

  test("preserves block structure for a selection spanning multiple blocks", () => {
    const first = schema.nodes.paragraph.create(null, schema.text("첫 문단"));
    const second = schema.nodes.paragraph.create(
      null,
      schema.text("Second paragraph", [schema.marks.italic.create()])
    );
    const doc = schema.nodes.doc.create(null, [first, second]);
    const slice = doc.slice(1, doc.content.size - 1);
    const selection = protectSelectionSlice(slice, "첫 문단 Second paragraph", "multiblock");
    const response = selection.protectedText
      .replace("첫 문단", "개선한 첫 문단")
      .replace("Second paragraph", "Revised second paragraph");
    const restored = restoreProtectedSelection(schema, selection, response);

    expect(restored.openStart).toBe(slice.openStart);
    expect(restored.openEnd).toBe(slice.openEnd);
    expect(restored.content.toJSON()).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "개선한 첫 문단" }] },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            marks: [{ type: "italic" }],
            text: "Revised second paragraph",
          },
        ],
      },
    ]);
  });
});
