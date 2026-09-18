# Linked figures

New figures selected through **그림 연결** refer to image files inside the project. An existing project image is linked in place. An image selected from outside the project is copied into `figures/`; an existing file with the same name is never overwritten. After importing, edit the project copy shown below the image.

## Change or repair a link

Use **다시 연결** to select another image, including when the old image is missing or cannot be displayed. The caption, reference identifier, numbering and dimensions stay in place. Cancelling the picker or encountering an import error keeps the old link.

## Refresh a changed image

Images update after changes to the linked file and when returning to the app. **Reload** explicitly reads the current file again and also retries a failed image. It refreshes only the image: document content and undo history are unchanged.

Missing and unreadable images display their stored path and recovery controls. Restore the file and use Reload, or choose a replacement with 다시 연결. Renaming or moving an individual image breaks its old link until it is relinked. Moving the complete project folder preserves project-relative links.

## Existing documents and export

Previously embedded images continue to display. They cannot follow changes to their former originals because no original path was stored. Use 다시 연결 once to associate each image with its desired source. Existing manuscripts are not automatically rewritten or matched to guessed filenames.

Markdown and Quarto files exported to `exports/` reference the project images using relative URLs such as `../figures/plot.png`. Keep the project folders together when sharing these source documents. Remote HTTP/HTTPS URLs and legacy embedded images remain supported.

## Verification

The linked-figure changes passed 44 tests (plus one pre-existing manuscript-dependent skip), TypeScript checking and the stable macOS build. Tests include temporary project files, deletion/restoration, concurrent imports without overwrites, path confinement, mounted BlockNote figures, relinking, reload, stale asynchronous results, schema persistence and export. The installed application and native file picker have not been interactively tested or replaced by this change.
