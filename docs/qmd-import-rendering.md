# QMD import and rendering repair

## Scope

- Recognize `$...$` inline math and single-line/multiline `$$...$$` display math before Markdown interprets TeX escapes or underscores.
- Preserve equation identifiers (`{#eq-...}`) in editable math blocks and QMD export.
- Restore math and bracketed citation groups in paragraphs, headings, lists, and table cells. Keep citation locators and exact citekeys so the existing editor bibliography loader can resolve `exports/references.bib`.
- Render the same math syntax in the MD/QMD viewer and load relative images through the existing project-restricted binary-file RPC.
- Remove multiplied BlockNote heading sizes; use 24px H1 and 20px H2 at the editor's 16px base size. Viewer headings use the same 1.5/1.25 ratios at its selected font size.

## Implementation boundary

Original QMD, image, and bibliography files are unchanged. Previously imported ScholarPen JSON is not migrated automatically; reimport the original QMD to obtain structured formulas and citations. The existing canonical bibliography loading path remains authoritative. This is not a full Quarto/CSL renderer: general cross-reference resolution and citation style processing remain outside this change.

## Validation

- `bun test`: 164 tests passed with the supplied `01-why.qmd` enabled through `SCHOLARPEN_IMPORT_FIXTURE`; this optional fixture check is skipped in normal runs (163 tests passed).
- The original manuscript contains 15 inline equations, 2 display equations, and 19 bracketed citation entries. All equations survive QMD export/reimport, and all citation keys match its bibliography.
- `bun x tsc --noEmit`, `git diff --check`, and `bun run build:release` passed.
- A local browser harness using the actual editor schema, importer, math components, and FileViewer verified KaTeX rendering, citation tooltips, heading sizes, and the first relative-path figure. Only the native RPC transport was replaced with local fixture responses for this check.
- Released as 1.1.1. The previous installed 1.1.0 application was backed up, `/Applications/ScholarPen.app` was replaced, and its extracted version/hash, running process, and native startup screen were verified. Feature interaction checks above used the browser harness; a full native import interaction was not repeated.
- The DMG passed `hdiutil verify`. The generated release skips code signing and notarization.
