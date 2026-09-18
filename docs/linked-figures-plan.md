# Linked figures

## Scope

- New figure selections link to a project-relative file. Files already inside the project stay in place; external files are copied into `figures/` without overwriting existing files.
- Persist the project-relative `sourcePath` separately from legacy `url` data. Existing embedded figures remain readable and can be relinked explicitly; do not rewrite existing manuscripts or guess their original files.
- Group file selection/relink, the local source path and Reload inside Figure properties. Keep only a compact Properties button on the figure; omit URL input. Apply commits a selected link, Cancel preserves the old link. Missing or unreadable images show their path and a recovery message instead of an empty rectangle. Relinking preserves captions, identifiers, numbering and layout.
- Refresh linked image bytes after relevant file changes and when returning to the app. Reload affects only the image, never the document or undo history. Discard stale reads and file-picker results after switching documents.
- Keep file reads confined to the selected project, including symlink resolution. Cancelling or failing selection leaves the old link intact.
- Export linked figures as paths relative to the existing `exports/` output folder; retain embedded-image compatibility.

## Verification

- Temporary-project tests: in-project linking, safe external import/name collisions, source edits/reload, deleted/recreated images, project moves, path/symlink confinement.
- Component tests: missing-image recovery, relinking, same-path reload, preserved figure properties, cancelled/stale operations, automatic refresh without document edits.
- Verify Markdown/Quarto export, TypeScript and production build. Distinguish source/build checks from installed-app interaction testing.
