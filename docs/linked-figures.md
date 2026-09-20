# Linked figures

New figures selected through **Properties → 파일 선택** refer to image files inside the project. An existing project image is linked in place. An image selected from outside the project is copied into `figures/`; an existing file with the same name is never overwritten. After importing, edit the project copy shown below the image.

## Change or repair a link

Open **Properties** and use **다시 연결** to select another image, including when the old image is missing or cannot be displayed. The caption, reference identifier, numbering and dimensions stay in place. Cancelling the picker or encountering an import error keeps the old link.

## Refresh a changed image

Images update after changes to the linked file and when returning to the app. **Reload** inside Properties explicitly reads the current file again and also retries a failed image. It refreshes only the image: document content and undo history are unchanged.

Missing and unreadable images direct the user to Properties, where the stored path and recovery controls are shown. Restore the file and use Reload, or choose a replacement with 다시 연결. Renaming or moving an individual image breaks its old link until it is relinked. Moving the complete project folder preserves project-relative links.

## Existing documents and export

Previously embedded images continue to display. They cannot follow changes to their former originals because no original path was stored. Use 다시 연결 once to associate each image with its desired source. Existing manuscripts are not automatically rewritten or matched to guessed filenames.

Markdown and Quarto files exported to `exports/` bundle referenced project images in `exports/figures/` and use local URLs such as `figures/plot.png`. Originals remain in their existing project locations. Both export and the app's Quarto render action refresh generated copies from their originals, including images selected from other project subfolders. Existing `../figures/` links are converted before rendering; original QMD files are backed up under `.scholarpen/backups/export-images-*/`. Captions, reference identifiers, prose and code examples are preserved.

Legacy base64 images are first extracted into `figures/embedded-<content-hash>.<extension>` without changing the document JSON, then bundled alongside other images. Repeated exports reuse identical files; edited originals are never overwritten. To make edits to an extracted original appear in the editor, use 다시 연결 to select it. Re-export QMD files after selecting a different source link.

The hidden `exports/.scholarpen-image-manifest.json` tracks generated copies. Edit the original images, rather than their exported copies. Missing originals, redirected export folders and independently edited generated copies stop preparation with a diagnostic; existing QMD content remains intact. Unrelated export-local images are preserved, including filename collisions. Share the whole `exports/` folder (including its figures, bibliography and extensions) to render it directly with Quarto elsewhere. Remote images still require network access. Direct CLI renders use the latest exported copies; refresh through ScholarPen after changing an original. No symlinks are required.

## Verification

The linked-figure changes passed 44 tests (plus one pre-existing manuscript-dependent skip), TypeScript checking and the stable macOS build. Tests include temporary project files, deletion/restoration, concurrent imports without overwrites, path confinement, mounted BlockNote figures, relinking, reload, stale asynchronous results, schema persistence and export. Properties groups the preview, local path, file picker, Reload, caption and layout. Apply commits a new link; Cancel keeps the previous one. Files copied from outside the project remain in figures/ even if the dialog is cancelled.


## 1.2.3 interface verification

The full suite passed 241 tests with one existing optional fixture skipped. TypeScript checking and the stable build passed. In the installed app, the `fig-basin-border` figure showed only Properties. Its dialog grouped the preview, local file selection, Reload, caption and layout; the native file picker opened, cancellation preserved the image, and Reload refreshed the preview. The document remained Saved after cancelling the dialog.
