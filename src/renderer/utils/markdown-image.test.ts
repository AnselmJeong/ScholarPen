import { expect, test } from "bun:test";
import { resolveMarkdownImage } from "./markdown-image";

test("resolves images relative to the QMD, including spaces, Unicode and parent folders", () => {
  expect(resolveMarkdownImage("figures/figure%201.png", "/project/한글 chapter/01-why.qmd"))
    .toEqual({ path: "/project/한글 chapter/figures/figure 1.png", mime: "image/png" });
  expect(resolveMarkdownImage("../figures/plot.svg", "/project/drafts/01.qmd"))
    .toEqual({ path: "/project/figures/plot.svg", mime: "image/svg+xml" });
  expect(resolveMarkdownImage("https://example.com/image.png", "/project/01.qmd")).toBeNull();
  expect(resolveMarkdownImage("javascript:alert(1)", "/project/01.qmd")).toBeNull();
});
