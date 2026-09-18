# Quarto identifiers, layout, and cross-references

## Implementation boundary

- Keep ScholarPen JSON as the editable source and Quarto as the final renderer.
- Persist stable labels on headings, figures, tables, and display equations. Preserve legacy `fig-N` identities; normalize legacy citation nodes with Quarto reserved prefixes without editing source files in place.
- Add a separate cross-reference inline node and an `@` picker for document targets, separate from bibliography citations.
- Provide block properties for labels, figure width/height/alignment, table captions, column width ratios, and column alignment while retaining BlockNote table editing.
- Preserve supported attributes through QMD import, JSON save/load, and export. Keep caption and alt text distinct. Preserve code examples and escaped reference text.
- Diagnose duplicate labels and missing cross-reference targets independently of bibliography; account for cross-chapter references at render time.
- Verify with real editor-schema round trips, bibliography and AI-protection regression tests, and actual Quarto HTML/Word/Typst output. Exercise the UI with a local browser harness when native automation is unavailable.
- Bump the application version after validation and produce a release build. Preserve unrelated existing worktree edits; do not commit or push unless requested.

## Project-wide reference follow-up

- Index every native document under `documents/`, including nested and unopened chapters, without indexing generated exports or backup copies.
- Merge saved targets with current in-memory contents of all loaded editor tabs; the active editor takes precedence. Display and search source document paths in the `@` picker.
- Refresh the saved index on each lookup, reusing parsed targets only for unchanged files. Report unreadable documents without hiding healthy chapters or bibliography suggestions.
- Verify cross-document insertion/export, unsaved label additions/deletions, file rename/deletion, nested documents, duplicate labels, and project isolation. Ship a patch release after checks.

## Compatibility boundaries

- Pipe tables provide per-column alignment and relative widths; merged cells and multiple header rows require an explicit diagnostic rather than silent data loss.
- Final numbering and page placement are Quarto's responsibility. Editor references display stable labels rather than pretending to know final cross-chapter numbers.
- General executable Quarto cells, arbitrary attributes, and all Quarto extensions are outside this change.
