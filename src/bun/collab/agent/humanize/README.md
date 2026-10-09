# Humanize

The `/humanize` manuscript action automatically selects a rulebook from the majority language of the whole accepted manuscript. The command edits prose; it does not remove watermarks.

- **Korean:** existing im-not-ai diagnosis, rulebook, and change-rate gates.
- **English:** [blader/humanizer](https://github.com/blader/humanizer), v3.1.0, pinned to `225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8`. The full upstream `SKILL.md` body is bundled in `english-rulebook.ts`; this upstream is an LLM instruction skill. The model performs its identify/draft/audit/final workflow in embedded mode using ScholarPen's configured provider. The MIT license ships with the app.

Run `bun scripts/sync-blader-humanizer.ts` to regenerate the pinned English rulebook and license. An explicit full commit SHA may be supplied to update them. No runtime download or separate service is required.

`language.ts` counts word tokens over all accepted prose, excluding code, inline atoms (including citation metadata/math), and unaccepted inserted text. Hangul-containing words count as Korean and Latin-script words as English; other scripts count separately. More than half of all tokens must belong to Korean or English. Ties, empty documents and unsupported-language majorities leave the document unchanged with an explanatory comment. This is a Korean/English heuristic, not a multilingual language-identification model.

The English route targets English prose while preserving headings, code, minority-language paragraphs and pending suggestions. Academic facts, quotations, citations, hedges, formatting and ScholarPen's protected boundaries override upstream examples that rearrange blocks or remove formatting. Revisions are suggestions for Accept/Reject; Observe zones remain proposals only. Korean processing keeps its existing behavior.
