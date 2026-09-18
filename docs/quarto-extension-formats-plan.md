# Heading 4 and Quarto extension formats

- Add Heading 4 to the editor's Turn Into menu; keep the existing heading schema (already supports levels 1–6).
- Discover format contributions from exports/_extensions, including namespaced installations. Treat manifests as data, skip common metadata and embedded dependencies, and report malformed manifests without hiding valid formats.
- Offer discovered and configured custom formats in the book configuration dialog. Preserve existing YAML options/comments; let users select or deselect extension formats.
- Render every configured format with its exact Quarto identifier, retaining configuration validation before launching Quarto.
- Verify discovery, YAML round trips, render arguments, type checking, and release build. Inspect the supplied project read-only.

## Verification

- 38 focused tests passed; one unrelated optional manuscript-fixture test skipped.
- Heading 4 survived the real BlockNote update, JSON reload, and Quarto export/import paths.
- React dialog smoke check verified selecting and saving `dst-book-typst`, passing that exact format to rendering, and displaying completion.
- The supplied project's extension was discovered without warnings; its existing format options were preserved in an in-memory configuration round trip.
- Type checking, whitespace checks, and the stable macOS build passed. The installed app was not replaced or click-tested; the build skipped signing and notarization.

## Follow-up: heading hierarchy

- Reproduced the production CSS with a real BlockNote editor: H1 24px, H2 20px, H3 24.96px. H3 combined a 1.3em wrapper with a 1.2em heading; only H1/H2 wrappers were normalized.
- Normalize all heading wrappers and increase selector specificity so BlockNote's element resets cannot win when styles load in a different order.
- Use H1/H2/H3/H4 sizes of 32/26/21/18px at the default root size; use matching relative sizes in zoomable Markdown previews.
- Verify computed styles in production and reversed CSS order, light/dark themes, and rebuild the installer.
- Verified in-browser with a real BlockNote editor: 32/26/21/18px in both stylesheet orders and both themes. A 20px Markdown preview scaled correctly to 40/32.5/26.25/22.5px. The stable app and DMG were rebuilt successfully.
