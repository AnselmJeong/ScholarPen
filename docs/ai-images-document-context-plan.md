# AI images and active document context

- Add screenshot paste and image file attachments to the assistant composer, with previews, removal, validation, and attachment persistence in existing thread metadata.
- Carry images through renderer history, typed RPC, context assembly, and provider-specific vision payloads. Preserve text-only calls; report unsupported models through provider errors.
- Snapshot the focused document directly from its live editor at send time, including unsaved edits. Send bounded structured document content as reference-only context and identify the active file in the sidebar.
- Verify multimodal request bodies, saved attachment restoration, active document switching/closing and truncation, plus TypeScript and production frontend build.

## Completed validation

- 199 tests passed; one existing optional manuscript fixture test skipped. TypeScript and `git diff --check` passed.
- Browser FileReader test covers screenshot/file data, distinct IDs for repeated filenames, preview readiness, completed attachments, and oversized-file errors.
- Integration tests cover Ollama/OpenAI/Claude image payloads, image-only requests, saved thread restoration, current document snapshots, and bounded context.
- Live Ollama check using the configured `deepseek-v4.1-flash` correctly identified a synthetic red square and blue circle and returned the active document's verification token.
- Release DMG built at `artifacts/stable-macos-arm64-ScholarPen.dmg`; disk-image checksum verification passed. Signing and notarization were skipped by the existing build configuration.
- Full desktop UI/clipboard verification remains unverified: native automation timed out opening the built app; the ordinary browser preview was blocked by the existing Electrobun WebSocket initialization outside its native host.

## User-facing behavior

Paste screenshots into the assistant input or use the image attachment button. Supports PNG/JPEG/WebP/GIF, up to four images per question, 5 MB each. The focused ScholarPen document is read directly from the editor on each ordinary chat request, including unsaved edits. Very long document context is bounded to 50,000 characters and marked as truncated. Inline media paths in the document are preserved as reference information; image pixels are supplied through explicit chat attachments.
