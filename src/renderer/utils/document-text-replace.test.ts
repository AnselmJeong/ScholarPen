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
  test("finds body prose only, excluding all figure metadata", () => {
    const matches = findDocumentTextMatches(document, "predictive processing");

    expect(matches).toHaveLength(1);
    expect(matches.map((match) => match.path)).toEqual([
      [0, "content", 0, "text"],
    ]);
  });

  test("replaces all matches without changing formatting or technical metadata", () => {
    const result = replaceDocumentText(document, "predictive processing", "active inference");
    const next = result.content as typeof document;

    expect(result.replacementCount).toBe(1);
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


test("ignores embedded image data and metadata named text/content", () => {
  const blocks = [{ type: "figure", props: { altText: "data:image/png;base64,CCKCCK", caption: "CCK", metadata: { text: "CCK", content: "CCK" } } },
    { type: "paragraph", content: [{ type: "link", href: "https://CCK.test", content: [{ type: "text", text: "CCK" }] }], history: { content: "CCK" } }];
  expect(findDocumentTextMatches(blocks, "cck")).toHaveLength(1);
  expect(replaceDocumentText(blocks, "cck", "term").replacementCount).toBe(1);
});

test("finds and replaces across formatting and links without losing marks", () => {
  const blocks = [{ type: "paragraph", content: [
    { type: "text", text: "C", styles: { bold: true } },
    { type: "link", href: "https://example.org", content: [{ type: "text", text: "CK C", styles: {} }] },
    { type: "text", text: "CK", styles: { italic: true } },
  ] }];
  expect(findDocumentTextMatches(blocks, "cck")).toHaveLength(2);
  expect(replaceDocumentText(blocks, "cck", "term").content).toEqual([{ type: "paragraph", content: [
    { type: "text", text: "term", styles: { bold: true } },
    { type: "link", href: "https://example.org", content: [{ type: "text", text: " term", styles: {} }] },
    { type: "text", text: "", styles: { italic: true } },
  ] }]);
});

test("keeps table cells and inline atoms separate and includes nested children", () => {
  const blocks = [{ type: "table", content: { type: "tableContent", rows: [{ cells: [
    [{ type: "text", text: "C" }], [{ type: "text", text: "CK" }],
    { type: "tableCell", content: [{ type: "text", text: "CCK" }] },
  ] }] } }, { type: "paragraph", content: [
    { type: "text", text: "C" }, { type: "citation", props: { citekey: "x" } }, { type: "text", text: "CK" },
  ], children: [{ type: "paragraph", content: "CCK" }] }];
  expect(findDocumentTextMatches(blocks, "cck")).toHaveLength(2);
});

test("preserves UTF-16 offsets and treats regex punctuation literally", () => {
  const blocks = [{ type: "paragraph", content: "İ CCK [CCK]" }];
  expect(findDocumentTextMatches(blocks, "CCK")[0].offset).toBe(2);
  expect(replaceDocumentText(blocks, "[CCK]", "term").content).toEqual([{ type: "paragraph", content: "İ CCK term" }]);
});

test("finds reference badges and targets with @, bare or partial keys, excluding other props", () => {
  const keys = ["fig-network", "tbl-results", "sec-methods", "eq-energy", "Smith2024"];
  const blocks = [
    { type: "paragraph", content: keys.map((key, index) => index === 4
      ? { type: "citation", props: { citekey: key, locator: "p. 2" } }
      : { type: "crossReference", props: { label: key } }) },
    ...["figure", "table", "heading", "math"].map((type, index) => ({
      type, props: { label: keys[index], url: "@hidden", altText: "@hidden", formula: "@hidden" },
    })),
    { type: "figure", props: { figureNumber: 7 } },
  ];
  keys.forEach((key, index) => {
    for (const query of [`@${key}`, key.toLowerCase(), key.slice(-4)]) {
      const matches = findDocumentTextMatches(blocks, query);
      expect(matches).toHaveLength(index === 4 ? 1 : 2);
      expect(matches.every((match) => match.kind === "annotation" && match.segments.length === 0)).toBe(true);
      for (const match of matches) {
        expect(match.snippet.slice(match.snippetOffset, match.snippetOffset + query.length).toLowerCase()).toBe(query.toLowerCase());
      }
    }
  });
  expect(findDocumentTextMatches(blocks, "@fig-7")).toHaveLength(1);
  expect(findDocumentTextMatches(blocks, "@hidden")).toHaveLength(0);
});

test("replacement preserves annotations and uses the original mixed-result index", () => {
  const blocks = [
    { type: "heading", props: { label: "sec-key" }, content: "@sec-key" },
    { type: "paragraph", content: [
      { type: "crossReference", props: { label: "sec-key" } },
      { type: "text", text: "@sec-key", styles: { bold: true } },
    ] },
  ];
  const matches = findDocumentTextMatches(blocks, "@sec-key");
  expect(matches.map((match) => match.kind)).toEqual(["annotation", "text", "annotation", "text"]);
  expect(replaceDocumentText(blocks, "@sec-key", "changed", 0)).toEqual({ content: blocks, replacementCount: 0 });
  expect(replaceDocumentText(blocks, "@sec-key", "changed", 2)).toEqual({ content: blocks, replacementCount: 0 });
  const one = replaceDocumentText(blocks, "@sec-key", "changed", 3);
  expect(one.replacementCount).toBe(1);
  expect(one.content).toEqual([blocks[0], { ...blocks[1], content: [
    blocks[1].content![0], { type: "text", text: "changed", styles: { bold: true } },
  ] }]);
  const all = replaceDocumentText(blocks, "@sec-key", "");
  expect(all.replacementCount).toBe(2);
  expect(findDocumentTextMatches(all.content, "@sec-key").map((match) => match.kind)).toEqual(["annotation", "annotation"]);
  expect(findDocumentTextMatches(blocks, "@sec-key")).toHaveLength(4);
});
