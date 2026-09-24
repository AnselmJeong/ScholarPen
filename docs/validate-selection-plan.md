# Validate selected text

- Add Validate between Improve and Deepen in the selection AI menu.
- Reuse Deepen's search/sidebar and protected selection replacement pipeline, with a distinct validate mode and concise report.
- Always request live evidence for Validate; fail without editing if search is disabled, fails, or returns no usable excerpts.
- Check factual, logical, and conceptual errors against retrieved sources and manuscript context. Correct only supported errors; preserve language, citations, formatting, and scope. Do not expand or stylistically rewrite sound text.
- Require an explicit CORRECTED, UNCHANGED, or UNCERTAIN verdict. Only CORRECTED may produce an automatic replacement. Preserve the original on uncertainty, cancellation, malformed output, or stale selection.
- Verify mode routing, search gating, result parsing, and protected replacement with focused tests, TypeScript, and a frontend build. Report desktop/live-model verification separately.

## Validation completed

- 41 focused tests passed across selection review, protected inline editing, and agent response options. Search calls used fixtures; no live model was used.
- Confirmed search runs with the per-question toggle off, globally disabled search blocks validation, and empty or metadata-only scholarly results cannot authorize a rewrite.
- Confirmed unchanged/uncertain verdicts return no replacement; incomplete verdicts, absent evidence citations, and broken revision markers are rejected.
- TypeScript and Vite production frontend build passed. Re-ran all 11 review tests after refining the Validate error labels.
- Installed desktop app was not replaced; live-model and desktop interaction verification remain unperformed.

## Validate revision repair (2026-09-24)

- Make each confirmed finding specify its actual before/after correction and require that correction in the final protected passage. Preserve unresolved claims without vetoing independent supported corrections. Allow unambiguous spelling/agreement corrections, without expanding Validate into stylistic rewriting.
- Accept harmless Markdown emphasis and CRLF in verdict/revision headings; continue rejecting conflicting verdicts, missing evidence, invalid markers, incomplete streams, and stale selections.
- Reject a CORRECTED result that contains no text change, and exercise the same completion/apply function used by the sidebar against a real ProseMirror document replacement.
- Verify prompt assembly, result parsing, automatic application, citation/format preservation, typecheck, and frontend build. Saved chat contains visible text only, so it cannot establish the original marker/application failure. Do not change manuscript data during verification.

### Repair validation

- 44 focused tests passed, including CORRECTED with an unchanged copy, emphasized/CRLF headings, automatic replacement of a saved ProseMirror range, preserved surrounding text/citations/bold marks, and no writes for interrupted or invalid results.
- TypeScript, Vite production frontend build, and `git diff --check` passed. Vite still reports existing bundle-size and Browserslist-age warnings.
- The configured live model (`ollama` / `deepseek-v4.1-flash`) corrected a synthetic causal-overclaim fixture and its raw response passed the sidebar completion function, which replaced the in-memory document selection while preserving bold marks and a citation node. Retrieval used synthetic evidence, not a live literature search; no user manuscript was edited.
- Apply success/failure is now included in saved assistant-message metadata for future diagnosis. Installed desktop app was not replaced or click-tested.
