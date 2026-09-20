# Heading block menu repair

## Scope

- Keep the right-margin Quarto properties control and restore reliable access to the left block menu.
- Render one custom side menu, keep its component identity stable across editor renders, and align its handles with ScholarPen's heading typography.
- Preserve heading identifiers, content, existing manuscript data, and unrelated worktree changes.

## Verification

- Exercise the real schema, shared side menu, and properties dialog in a browser: one handle, heading-level and color changes, properties edits, hover movement, narrow layout, and scrolling.
- Run TypeScript, the relevant editor/schema regression tests, and the production build.
- Report packaged build verification separately from installed macOS app verification.

## Findings

- `BlockNoteView` mounted its default side menu alongside the custom controller, producing two overlapping handles.
- Inline component callbacks changed identity during editor-pane renders and could remount an open menu.
- BlockNote's default H1/H2 menu heights (78/54px) no longer matched ScholarPen's compact heading typography. The handle color also depended on stylesheet order.
- Heading typography overrode explicit block text colors. Let explicitly colored headings inherit BlockNote's block color.

## Results

- TypeScript and `git diff --check` passed.
- Quarto schema/parser/serializer and theme checks: 42 passed, 1 skipped (optional manuscript fixture).
- Browser checks passed using the real schema, `EditorSideMenu`, `QuartoBlockControls`, and properties dialog: one handle, preserved open menu through a parent render, H1 to H2/H3 changes, red/blue text colors, identifier retention, both properties entry points, a 680px-wide viewport, and a scrolled heading. Explicit heading colors remained visible under the app's dark-mode CSS.
- Production macOS release build completed. Installed `/Applications/ScholarPen.app` was not replaced or validated with the new build. Signing and notarization were skipped by the existing release configuration.
