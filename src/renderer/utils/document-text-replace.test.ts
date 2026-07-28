import { describe, expect, test } from "bun:test";
import {
  findDocumentTextMatches,
  replaceDocumentText,
} from "./document-text-replace";

const document = [
  {
    id: "paragraph-1",
    type: "paragraph",
    props: {},
    content: [
      { type: "text", text: "Predictive processing and predictive coding.", styles: {} },
      { type: "citation", props: { citekey: "Predictive2024", locator: "" } },
    ],
    children: [],
  },
  {
    id: "figure-1",
    type: "figure",
    props: {
      caption: "Predictive processing overview",
      altText: "predictive processing diagram",
      url: "https://example.com/predictive-processing.png",
      formula: "predictive processing",
    },
    content: [],
    children: [],
  },
];

describe("document text replacement", () => {
  test("finds prose and human-readable figure metadata only", () => {
    const matches = findDocumentTextMatches(document, "predictive processing");

    expect(matches).toHaveLength(3);
    expect(matches.map((match) => match.path)).toEqual([
      [0, "content", 0, "text"],
      [1, "props", "caption"],
      [1, "props", "altText"],
    ]);
  });

  test("replaces all matches without changing formatting or technical metadata", () => {
    const result = replaceDocumentText(document, "predictive processing", "active inference");
    const next = result.content as typeof document;

    expect(result.replacementCount).toBe(3);
    expect(next[0].content[0]).toEqual({
      type: "text",
      text: "active inference and predictive coding.",
      styles: {},
    });
    expect(next[0].content[1]).toEqual(document[0].content[1]);
    expect(next[1].props.url).toBe(document[1].props.url);
    expect(next[1].props.formula).toBe("predictive processing");
    expect(document[0].content[0].text).toBe("Predictive processing and predictive coding.");
  });

  test("replaces one selected occurrence while preserving the others", () => {
    const result = replaceDocumentText(
      [{ type: "paragraph", content: "term term term" }],
      "term",
      "concept",
      1,
    );

    expect(result.replacementCount).toBe(1);
    expect(result.content).toEqual([{ type: "paragraph", content: "term concept term" }]);
  });

  test("keeps each preview anchored to its own occurrence", () => {
    const matches = findDocumentTextMatches(
      [{ type: "paragraph", content: `term ${"context ".repeat(6)}term` }],
      "term",
    );

    expect(matches).toHaveLength(2);
    expect(
      matches[1].snippet.slice(
        matches[1].snippetOffset,
        matches[1].snippetOffset + matches[1].length,
      ),
    ).toBe("term");
  });

  test("matches case-insensitively and supports whitespace corrections", () => {
    const result = replaceDocumentText(
      [{ type: "paragraph", content: [{ type: "text", text: "Deep  Learning deep  learning", styles: {} }] }],
      "deep  learning",
      "deep learning",
    );

    expect(result.replacementCount).toBe(2);
    expect(result.content).toEqual([
      {
        type: "paragraph",
        content: [{ type: "text", text: "deep learning deep learning", styles: {} }],
      },
    ]);
  });
});
