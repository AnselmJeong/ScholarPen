# Quarto properties controls

## Scope

- Replace the breadcrumb's fixed properties button with a control in the selected referenceable block's right margin.
- Keep the control outside ProseMirror's editable DOM and preserve existing block menus and figure/equation controls.
- Follow keyboard/mouse selection and document reflow; hide on ordinary paragraphs, multi-block selection, and focus outside the editor. Restore editor focus when closing properties.
- Disable automatic capitalization, correction, spelling checks, and autocomplete only on the identifier field. Preserve manually entered case and existing validation.
- Preserve all pre-existing worktree changes and manuscript data. Do not change export/title behavior in this UI patch.

## Verification

- TypeScript and existing Quarto parser/serializer/schema regression tests.
- Browser harness using the real editor schema, margin control, and properties dialog: heading switching, ordinary-paragraph hiding, table identifier save, input attributes, narrow layout, and scrolling.
- Production frontend and macOS release build. Browser verification does not prove installed WKWebView or macOS automatic text replacement behavior; do not claim installed-app validation without exercising it.
