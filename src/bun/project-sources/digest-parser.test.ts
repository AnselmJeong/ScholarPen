import { describe, expect, test } from "bun:test";
import { parseDigest } from "./digest-parser";

describe("parseDigest", () => {
  test("preserves YAML source metadata, heading hierarchy, lines, and page locators", () => {
    const parsed = parseDigest(`---
schema_version: scholarly-digest/v1
title: Placebo review
authors: [Kim, Lee]
year: 2026
source_relpath: group/paper.pdf
source_page_count: 8
---
# Main

Intro [Source: Introduction, p.2]

## Results

Effect details [Source: Results, pp.4–5]
`, "/project/resources/articles/group/summary/digest.md");
    expect(parsed.metadata.sourceRelpath).toBe("group/paper.pdf");
    expect(parsed.metadata.authors).toEqual(["Kim", "Lee"]);
    expect(parsed.chunks.map((chunk) => chunk.headingPath)).toEqual(["Main", "Main > Results"]);
    expect(parsed.chunks[0].pageStart).toBe(2);
    expect(parsed.chunks[1].pageEnd).toBe(5);
    expect(parsed.chunks[0].lineStart).toBeGreaterThan(7);
  });

  test("falls back to legacy heading and filename metadata without YAML", () => {
    const parsed = parseDigest("# Better title\n\nLegacy digest body.", "2020 - Smith - Filename title.md");
    expect(parsed.metadata.title).toBe("Better title");
    expect(parsed.metadata.year).toBe(2020);
    expect(parsed.chunks).toHaveLength(1);
  });
});
