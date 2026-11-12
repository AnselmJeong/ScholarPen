# Local DetectorScope analysis

`/ai-score`, explicit sidebar detection requests and AI-assigned detection comments
use [DetectorScope](https://github.com/google-deepmind/detectorscope). The previous
Qwen/Binoculars scoring path has been removed. No LLM invents or summarizes scores.

## Install and run

Users install directly from **Settings → DetectorScope → 설치·다운로드**. When
the runtime or models are missing, the Activity and Assistant panels show the same
installer. It reports five stages, file/byte download progress, cancellation, and
retry. Closing the panel keeps the download running; quitting the app cancels it.
The installer checks for 20GB free space, downloads and verifies the pinned official
uv archive, and creates managed Python without Homebrew, a system Python, Terminal,
or a repository checkout. This packaged path currently supports Apple Silicon macOS.
It stores tools, Python, and dependencies under the application support directory.
The official uv 0.11.7 archive is verified against its published SHA-256 checksum.

For development, `bun run setup:ai-detector` remains available (requires `uv`).
Both paths create an isolated Python
3.12 environment, installs the hashed dependencies from `python/requirements.lock`,
downloads the pinned open-domain detector (Gemma 2 2B, SAEs, feature descriptions,
and heads; several GB), and performs an actual offline inference with highlights.
The model/package identity and tau are in `python/detector_config.json`.

Missing models are detected through an offline cache probe rather than a permanent
ready flag. Installation and inference cannot run together. Dependencies are
hash-pinned; models use the pinned revision. Success is shown only after a real
offline analysis passes result validation.

The interpreter is under
`~/Library/Application Support/ScholarPen/ai-detector/detectorscope/.venv`.
`SCHOLARPEN_DETECTOR_PYTHON` may explicitly override it for development.
`SCHOLARPEN_DETECTOR_HOME` isolates installer/runtime tests in a scratch directory. Models use the normal
Hugging Face cache. Runtime inference enforces offline mode and uses an absolute
interpreter path; no shell PATH or repository directory is needed. Worker source
and config are embedded in the Bun bundle and materialized in app support.

To refresh dependency locks after deliberate upgrades:

```sh
uv lock --project src/bun/ai-detector/python
uv export --project src/bun/ai-detector/python --format requirements-txt --no-dev --output-file src/plugins/ai-writing-score/main/python/requirements.lock
```

## Results and interpretation

- Every window reports the real model `p_ai`, logit, label and saved head threshold.
  The upstream decision is `logit > threshold`; it is not assumed to be 0.5.
- The open-domain model is used, not the narrow GPT-4o peer-review classifier.
- Logistic regression, tau 0.85. Tau filters features by description validation;
  it is not a probability/decision threshold.
- Up to three positive and two negative features are shown per window. Each has
  its original description, signed logit contribution and up to two localized
  source excerpts in the displayed report (three locations retained by the adapter).
  Positive pushes toward AI; negative toward human. Activations locate a feature,
  not a sentence-level authorship probability. Other contributions remain explicit.
- Bias + displayed contributions + remaining contributions must equal the logit.
- The model's percentage is not verified real-world authorship probability, nor
  the percentage of AI-written sentences. No global probability is fabricated
  from multiple windows. Korean and scholarly manuscript accuracy is unvalidated.
- These are research artifacts and must not decide academic integrity, hiring or
  publication outcomes. False positives are possible.

DetectorScope 0.0.1 truncates inputs at 1,024 tokens including special tokens. The
adapter partitions filtered inference slices, checks every slice against the same
tokenizer and verifies the model's exact token strings before reporting locations.
It analyzes every slice sequentially, including the tail. Independent windows
change context relative to single-document inference; this is disclosed.

Offsets are UTF-16 positions in the analyzed prose snapshot (not editor positions).
Square-bracket content (including nested/multiline brackets) is excluded from the
inference copy, replaced by one separator per outer range. An unclosed opening
bracket excludes the rest of the input. Token limits apply after exclusion.
A source map restores original snapshot positions and splits highlights crossing
excluded ranges; the service also rejects highlights inside brackets. No manuscript
edits occur. Unicode offsets are
converted explicitly; zero-length special-token and overlapping byte-token
highlights are excluded/deduplicated. Limits: 100,000 UTF-16 code units, 32,000
input tokens, minimum 64 tokens, ten-minute deadline, one worker at a time.
On macOS the upstream CPU path is retained; CUDA is selected by upstream when
available. Model setup, memory, timeout and cancellation failures never produce
substitute scores. Short final windows carry a warning.

Assistant and Activity use the same interactive result card: an explicit verdict,
flagged-window count, 0–100 score with the real model threshold on the same scale,
window selection and selectable model features. Technical values are collapsed.
Markdown remains the portable storage/export format, without hidden JSON payloads.

`/ai-score` replaces the previous detection result. Editor document commands remove
old score threads immediately, cancel superseded in-flight analysis, and create one
fresh result. Other comments and manuscript text remain untouched. Repeated
requests in a comment replace its previous report. Chat removes older detection
turns from the visible conversation and SQLite history while preserving unrelated
messages. There is no separate rescore button or reanalysis recommendation.
Completion time, per-window tokens and a plain token-window explanation remain.

Feature descriptions are pretrained auto-interpretations, not diagnoses of an
individual highlighted word. Token activation locations are collapsed under
“model response locations” and nearby excerpts are merged. For repeated-phrase
features, a separate deterministic check looks for non-overlapping repeated
3–12-word sequences in that window that overlap an activation. Citation ranges
and sentence/line boundaries are excluded. Only verified occurrences are shown as
textual evidence; otherwise no word substitution is suggested. This check is not
proof of AI authorship or needless repetition, and does not predict the effect of
an edit on the score. Other feature types do not invent editing diagnoses.

The UI score is p_ai × 100, not a calibrated authorship probability. Verdicts use
unrounded logits (strictly above the threshold); rounding never changes the label.
The real checkpoint threshold 0.5008 corresponds to about 62.3 on the displayed
scale. No document-wide probability is fabricated for multiple windows.

## Validation

```sh
bun test src/shared/ai-detection.test.ts src/plugins/ai-writing-score/main/service.test.ts src/plugins/ai-writing-score/main/installer.test.ts src/renderer/components/sidebar/AIDetectionResult.test.tsx
bun test src/renderer/components/settings/AIDetectorSetup.test.tsx
python3 -m unittest discover -s src/bun/ai-detector/python -p 'test_*.py'
bun test src/bun/collab/agent/agent.test.ts
bun test src/renderer/collab/collab-e2e.test.tsx
bunx tsc --noEmit
```

Python tests exercise coverage, Unicode alignment, thresholds, signed evidence,
and truncation rejection without model downloads. Setup and the smoke script run
real local inference. Dependencies and checkpoints keep their upstream licenses;
the download includes the model README/NOTICE and package license metadata.

`scripts/smoke-ai-detector-install.ts` verifies an empty runtime directory with a
restricted PATH outside the checkout; the model cache may be reused to avoid
re-downloading 12GB. A separate isolated-cache check removes the default head
and verifies that missing-model detection and the download path repair it.
