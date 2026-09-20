# Editor mini outline

## Scope

- Add a compact outline to the right of each manuscript editor with headings H1–H6 in document order, nested by heading level.
- Navigate to a heading on click; expand/collapse subsections without changing the manuscript. Follow the editing cursor and manual scrolling with an active-section highlight.
- Refresh after heading edits, insertion, removal, reordering, and document reload. Preserve stable identities when titles repeat.
- Provide a breadcrumb toggle and a close control, remember visibility locally, and support empty documents and long titles.
- Dock beside the editor when there is room; use a right overlay in narrow/split panes. Scope DOM queries and scrolling to the correct editor.
- Preserve existing Quarto controls, side menus, autosave, and unrelated worktree changes. Do not modify manuscript files during validation.

## Validation

- Test hierarchy with skipped levels and nested blocks, rich heading text, section lookup, duplicate titles, and input preservation.
- Run the real editor/outline in a browser for navigation, folding, live edits, scroll tracking, persistence, empty state, split/narrow layout, and existing heading controls.
- TypeScript, relevant editor tests, production release build, and packaged asset verification. Report installed-app validation separately.

## Verified behavior

- The browser harness rendered the production `EditorArea`, with filesystem/AI communication replaced by in-memory fixture responses. No manuscript files were read or written.
- Clicking a section moved the caret to that heading, aligned it 24px from the editor viewport top, and produced zero save calls.
- Folding hides descendants and highlights their parent when the active subsection is folded. Editing, adding, deleting, or changing heading levels updates the outline.
- Manual scrolling changes the active section; hiding survives reload; navigation in a split pane leaves the other pane's scroll position unchanged.
- Narrow panes use an overlay. Long Korean titles wrap, and the empty state, dark-theme styles, existing block menu, and Quarto properties dialog were exercised.
- TypeScript and focused automated tests passed: 47 passed, 1 skipped (optional manuscript fixture).
- The production macOS release build completed, and its embedded renderer assets match the verified frontend build. The existing configuration skips code signing and notarization. The installed app was not replaced.

## Compact sizing revision

- The user requested a true minimap that leaves more room for writing. Reduce docked width from 240px to 160px and narrow-pane overlay width from 260px to 160px.
- Reduce title text from 13px to 10px, tighten line height and row padding, and reduce hierarchy indentation from 14px to 8px per level. Retain complete wrapped titles and existing navigation/visibility behavior.
