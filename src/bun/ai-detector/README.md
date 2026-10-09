# Local AI writing score

The user's `Watermark_Detector/detector/text_ai_score.py` and
`text_hidden_chars.py` were copied on 2026-10-09 into `python/detector/`.
They remain independent of ScholarPen's watermark removal and Humanize actions.
No third-party detector API receives manuscript text.

## Use

- Once per computer: `bun run setup:ai-detector` (requires `uv`). This installs
  Python 3.12, pinned PyTorch/Transformers and the two Qwen 0.5B models.
- Editor slash menu: **AI writing score** (`/ai-score`), whole current document.
- AI sidebar: `/ai-score` or `AI가 썼을 가능성을 계산해줘`; uses selected text,
  otherwise the full live prose snapshot. `/ai-score <passage>` analyzes pasted text.
- An AI-assigned comment requesting detection analyzes its anchored text; a
  document comment analyzes the document. Results are saved as comments/chat replies.
- No document text is modified. Analysis only runs on an explicit request.

The Python runtime lives in `~/Library/Application Support/ScholarPen/ai-detector/.venv`.
`SCHOLARPEN_DETECTOR_PYTHON` can explicitly override the interpreter. Worker sources
are embedded in the Bun bundle and materialized in a content-addressed directory
under that same app support folder. Neither a sibling checkout nor Terminal PATH
is required at runtime. Models must be installed first; inference sets Hugging Face
offline mode. Missing models, cancellation, short inputs and timeouts return errors,
never substitute an LLM-estimated number. Analysis is limited to 100,000 UTF-16
code units / 32,000 model tokens, with a ten-minute deadline and one worker at a time.

## Meaning of the score

This is an experimental **Binoculars-derived raw score**, not a calibrated
probability of AI authorship. The prototype's Falcon-derived 0.90 threshold is not
used for the Qwen pair. No human/AI verdict or synthetic percentage is displayed.
The reference implementation is https://github.com/ahans30/Binoculars .

The adapter reuses `AITextScorer`'s models and the prototype's shifted-logit formula,
but processes all input in windows of 256 tokens with one overlapping context token.
Each next-token transition is scored exactly once. The document score is total
performer NLL / total observer-to-performer cross entropy; the range contains the
per-window ratios. Unlike the official single-window implementation, the prototype
computes cross entropy only at positions having a next-token target. Do not transfer
published thresholds to this variant or model pair. Perplexity uses the observer.
Hidden characters are scanned in the original text; a cleaned in-memory copy is
scored. Smart punctuation is excluded from the hidden-character count. Hidden
characters and ordinary whitespace are not evidence of AI authorship.

To support a real probability in future, obtain representative human/AI-labelled
Korean and English academic text, fit a calibration model, and evaluate it on a
held-out corpus with language/length/domain-specific reliability checks. Threshold
calibration alone does not produce a probability.

## Validation

`bun test src/shared/ai-detection.test.ts src/bun/ai-detector/service.test.ts`

`python -m unittest discover -s src/bun/ai-detector/python -p 'test_*.py'`

The collaboration agent and editor E2E suites additionally verify request routing,
last-block inclusion, unchanged content and slash-menu wiring.
