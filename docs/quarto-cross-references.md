# Quarto references and layout — ScholarPen 1.2.1

## Editing

- Select a heading, table, image, figure, or equation to reveal the **Quarto properties** control in its right margin. It follows the selected block as the document scrolls or reflows, and hides for ordinary paragraphs, selections spanning several blocks, or focus outside the editor. The block menu remains available; figures and equations also have a **Properties** button directly on the block.
- Identifier fields disable automatic capitalization, autocorrection, spelling checks, and autocomplete so reference keys are entered literally. User-entered case is preserved; required prefixes such as `fig-` and `tbl-` remain lowercase.
- Assign a stable identifier: `sec-state`, `fig-one`, `tbl-one`, or `eq-steady-state`. Enter it without `#`; a pasted leading `#` is also accepted. **Generate** creates a unique identifier from the block ID. Leave it blank for an unlabelled block.
- Type `@` to search **Project references** separately from **Citations**. The picker indexes all native documents under the project’s `documents/` folder, including nested and unopened chapters. Search by identifier, caption/formula, or source document path. The current document appears first; each result shows its source path. Open editor tabs contribute their latest unsaved contents. A reference badge navigates to a target in the current document; Quarto resolves references across chapters when the full book is rendered.
- Figure properties include caption, alternative text, width, height, and left/center/right alignment. A width such as `65%` or `10cm` with height left blank preserves the aspect ratio.
- Table properties include caption, identifier, column width shares, and column alignment. Widths `40, 60` mean 40% and 60%; any positive ratio is accepted. Alignment applies to all cells in that column. Native column resizing is also reflected in QMD export.
- Equation identifiers are separate from the LaTeX formula. Final reference numbering is assigned by Quarto, not by the editor.

Changing an identifier does not rename existing references automatically. The properties dialog calls this out. Reordering blocks preserves identifiers. Labels must be unique across a rendered book.

## QMD output

```qmd
## State {#sec-state}

![Caption](<figure.png>){#fig-one width="65%" fig-align="right"}

| Name | Value |
| :--- | ---: |
| A | 1 |

: Caption {#tbl-one tbl-colwidths="[40,60]"}

$$
x = 1
$$ {#eq-steady-state}

See @sec-state, @fig-one, @tbl-one and @eq-steady-state.
```

QMD documents with section identifiers enable `number-sections: true`. Newly generated Word book configurations enable section numbering too. Existing explicitly configured numbering settings are preserved and can override document-level defaults.

## Compatibility and diagnostics

- Existing `figureNumber` identities retain their `fig-N` labels. Existing native image blocks retain their URLs, captions, alignment, and preview widths when converted to figure blocks.
- Older heading labels stored as trailing text, plain detached table captions with attributes, and internal references incorrectly stored as citations are normalized when loaded/exported. Source JSON is not rewritten merely by opening it; normal editing/save persists the upgraded representation.
- Bibliography scanning and citation-key remapping exclude Quarto's reserved reference namespaces. AI inline rewrites protect reference nodes like other atomic inline content.
- Duplicate static identifiers across configured book chapters are checked before rendering. Unresolved cross-reference warnings are reported as document-reference errors even when Quarto exits with status zero. They are not presented as missing bibliography entries.
- Markdown code examples and escaped reference text remain literal through import/export.
- Pipe tables support column alignment and relative width shares. Merged cells and multiple header rows produce an export diagnostic instead of silently losing structure. Arbitrary Quarto attributes, executable cells, subfigure layouts, and extension-generated targets are not a general round-trip guarantee.

## Validation

- 222 tests passed; one optional external-manuscript fixture skipped. TypeScript and whitespace checks passed.
- Real BlockNote schema tests cover import → JSON reload → export → reimport, native mounted heading/table views, legacy migration, literal/code protection, native images, duplicate IDs, missing references, and AI-edit protection.
- A browser harness using the actual schema, importer/exporter, properties dialogs, and reference picker verified figure width/alignment, table widths/alignment/caption, section/equation properties, invalid-label validation, reference insertion, and JSON reload. Only the native RPC boundary was stubbed; this is not installed-app interaction evidence.
- Quarto 1.10.18 rendered single-document HTML, DOCX, and Typst PDF with all four target types, figure width, table width shares, and alignment. HTML links/styles, DOCX bookmarks/table widths, and PDF text/layout were inspected.
- A two-chapter book verified cross-chapter section, figure, and equation references in HTML, DOCX, and Typst PDF. The Typst book fixture includes an author: Quarto's bundled orange-book template failed without one.
- The macOS arm64 release build and DMG checksum verification passed. The mounted DMG contains version 1.2.0 and the same application payload as the build; both editor controls and render diagnostics were verified in that payload. The installed app was not replaced or exercised. Developer ID signing and notarization were not applied.

## 1.2.1 project-wide reference update

- Saved chapter targets are refreshed on every suggestion lookup; unchanged files reuse their parsed index. Exports, hidden backups, and symbolic links are excluded. There is no directory-depth limit.
- Unsaved changes in loaded tabs replace the corresponding saved targets, including label deletions. Renamed/deleted files drop out of the saved index. Identifiers duplicated across documents are marked in the menu; rendering still requires unique identifiers.
- A corrupt document reports its source filename while other chapters and citations remain available.
- Tests cover nested/unopened chapters, changes/renames/deletions, project isolation, unsaved tab precedence, legacy labels, partial failures, and cross-chapter insertion into the real BlockNote schema followed by QMD export.
- A browser harness connected the actual filesystem index to the actual editor schema and suggestion menu: typing `@` displayed an unopened chapter's figure and equation with their source path, filtering `eq-` selected the equation, and exporting produced `See [@eq-steady-state]`. The harness substitutes HTTP for the native RPC transport; installed-app interaction was not exercised.
- The 1.2.1 arm64 release build passed. The DMG checksum and mounted application version were verified, and its payload matches the build and includes both the project-index RPC and project-wide picker. Developer ID signing/notarization were not applied; the installed app was not replaced.
