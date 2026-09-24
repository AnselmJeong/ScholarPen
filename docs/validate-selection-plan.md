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
