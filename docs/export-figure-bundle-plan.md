# Portable export figures

## Scope

- Keep original project images and ScholarPen documents in place.
- Bundle referenced local images inside `exports/figures/` when writing Markdown/Quarto and before rendering a configured Quarto book. Use relative URLs inside the export root so Typst needs no root override.
- Track generated copies and their source paths so later renders refresh changed originals. Preserve unrelated export images; do not write through symlinks or silently overwrite independently edited copies.
- Prepare existing exported chapters without changing prose, captions, labels, citations or code examples. Back up QMD files before rewriting existing image destinations.
- Keep remote images and ordinary export-local images usable. Report missing sources before replacing a QMD file.
- Verify real file export, repeat rendering after source changes, existing book migration, failure preservation and the user's custom Typst book. Unresolved `@fig-slowing` remains a separate manuscript issue.

## Validation

- Focused filesystem/export/render tests and TypeScript checking.
- Production build and real Quarto render using the current manuscript and template.
- State precisely whether the installed app was replaced or exercised.

## Results (2026-09-20)

- Full suite: 280 passed, one existing optional manuscript fixture skipped; TypeScript and the stable build passed.
- Current book: 24 copied images match their originals byte for byte. Seven QMD chapters changed only image destinations; backups were created before rewriting.
- Custom `dst-book-typst` rendered the 57-page PDF without a root override. Copying only `exports/` to a temporary location with no sibling `figures/` also rendered successfully.
- The pre-existing `@fig-slowing` reference has no target in exported chapters. Quarto writes the PDF with that warning; ScholarPen correctly continues to report the unresolved reference separately.
- Installed the built app at `/Applications/ScholarPen.app` after confirming it was closed, retaining the previous bundle under `~/Library/Application Support/ScholarPen/App Backups/export-figures-20260920-182347/`.
- Opened the installed app, selected the book and clicked Render. Its Quarto run completed with exit code 0 and only the known unresolved `@fig-slowing` diagnostic; closed the dialog afterward.
- Packaging skipped Developer-ID signing and notarization; DMG integrity verification passed.
