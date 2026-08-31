import { describe, expect, test } from "bun:test";

const themeAwareSurfaces = [
  "./blocks/abstract-block.tsx",
  "./blocks/citation-inline.tsx",
  "./blocks/figure-block.tsx",
  "./blocks/inline-math.tsx",
  "./blocks/math-block.tsx",
  "./components/editor/DOIInputDialog.tsx",
  "./components/editor/EditorPaneGroup.tsx",
  "./components/sidebar/IconRail.tsx",
] as const;

const lightOnlyStyle = /\b(?:bg-white(?:\/\d+)?|bg-gray-(?:50|100|200)|text-gray-(?:400|500|600|700|800)|border-gray-(?:100|200|300)|hover:bg-blue-50)\b|#1e1b4b/i;

describe("theme-aware editor surfaces", () => {
  for (const relativePath of themeAwareSurfaces) {
    test(`${relativePath} does not bypass the theme tokens`, async () => {
      const source = await Bun.file(new URL(relativePath, import.meta.url)).text();
      expect(source).not.toMatch(lightOnlyStyle);
    });
  }
});
