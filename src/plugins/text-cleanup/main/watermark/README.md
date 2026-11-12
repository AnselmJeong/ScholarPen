# Remove watermark

The independent slash action cleans the **currently open document**, regardless of selection. It runs locally without an LLM, Python installation, or external service. It uses a TypeScript port of the default Layer A `clean_text` / `_decide` policy in [guillaumemeyer/watermarks-remover](https://github.com/guillaumemeyer/watermarks-remover/blob/c5297e9e69fec0779c29127c7892427e673fafd9/service/scripts/text_unicode.py), pinned to `c5297e9e69fec0779c29127c7892427e673fafd9` (MIT; notice bundled).

- Remove invisible Unicode carriers and normalize exotic spaces.
- Preserve contextual emoji/script joiners, variation selectors, Hangul jamo fillers and legitimate bidi controls, matching upstream defaults.
- Do not run NFKC or aggressive homoglyph conversion.
- Preserve rich-text marks, citations, links, inline atoms, literal markup and code. Defer blocks with pending suggestions.
- Apply the cleanup as one Yjs transaction, reversible using **Undo last AI edit**. This deliberately avoids the suggestion library's special handling of U+200B, which would corrupt literal zero-width text during Accept/Reject.

This action does not rewrite prose (Humanize does that), detect or certify removal of statistical token-sampling watermarks, or clean attached PDF/image metadata. Counts in the completion comment describe actual character operations, not proof that the original text was watermarked.
