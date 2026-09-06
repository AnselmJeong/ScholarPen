# Document find repair

Scope: search body content only in documents/**/*.scholarpen.json, using live content for open documents. Exclude props, image data, URLs and other metadata. Preserve original files during investigation.

- Traverse BlockNote body structure explicitly; match across inline formatting and links, keep table cells and atom boundaries separate, preserve formatting on replacement.
- Use the same text matching rules for persisted documents and ProseMirror positions.
- Add result lists and exact-position navigation in both scopes; open destination tabs and wait for document load before navigating.
- Preserve relative document paths for nested files and constrain document IO to the documents directory.
- Validate with regression tests, typecheck, production frontend build and a browser interaction check if available.

Validation completed:
- 157 Bun tests passed, including body-only extraction, image payload exclusion, styled/link-spanning words, tables, nested children, exact ProseMirror positions, and nested IO with recovery copies and traversal rejection.
- Headless Chrome exercised the real EditorPaneGroup and EditorArea with fixture RPC data: current-document click, delayed cross-document load to the second occurrence, This document result click, nested document navigation, Next wrapping back to an open tab, and a live unsaved edit. Assertions checked both the cursor text and visible screen coordinates.
- Read-only scan of the reported 06/07/08 documents returned one body CCK match each. The old 06 result set included 90 matches from image altText.
- The temporary browser fixture was removed after validation; no user documents were edited.
