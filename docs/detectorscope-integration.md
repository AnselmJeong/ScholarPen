# DetectorScope integration and first-run installation

Verified on 2026-10-28 on Apple Silicon macOS.

## User flow

- Existing `/ai-score`, editor slash menu and detection comments use DetectorScope.
- Results show each window's model score, the checkpoint's real decision threshold,
  signed feature contributions, and highlighted source excerpts. Both AI-directed
  and human-directed features are included; the original manuscript is unchanged.
- Settings always includes DetectorScope setup. Activity and Assistant show the
  same download controls when the runtime or model cache is missing.
- Installation downloads a verified official uv executable, managed Python 3.12,
  pinned dependencies and the pinned model. No terminal, Homebrew, system Python,
  API key, or source checkout is needed. Downloads require internet; analysis is offline.
- Progress, cancellation and retry are available. Closing a panel keeps installation
  running; quitting the app cancels it. Completed cached model files are reused.
- Apple Silicon macOS; about 12GB initial download, 20GB free-space requirement.

## Runtime evidence

- DetectorScope 0.0.1, `liamdugan/detector-scope`, revision
  `9baaff9e2d1cdb79cafa90cdb27811b847e69dae`, logreg, tau 0.85.
- Actual checkpoint threshold: logit > 0.5008. Tau is a separate feature-description
  validation threshold, not an authorship probability threshold.
- Bundled service smoke from `/tmp`, with `PATH=/usr/bin:/bin`: 1,542 tokens in
  two windows, source preserved including Korean/emoji and final text; five
  localized feature explanations per window; 16.538 seconds on this machine.
- Empty installer data directory and restricted PATH: bootstrapped uv and managed
  Python, installed dependencies, then passed real offline inference.
- Repeated that cold-runtime test using **Bun 1.3.9 extracted from the release app**.
- Cold-runtime tests reused the already downloaded model cache to avoid another
  12GB transfer. Model download itself was exercised initially; an isolated cache
  with the default detector head removed was correctly identified as missing,
  downloaded the absent file, and passed offline inference afterward.
- A separate fresh installation was cancelled during bootstrap; state returned
  to missing and the installer lock was released.

## Checks

TypeScript, focused shared/worker/installer tests, settings UI tests, collaboration
agent tests and mounted editor E2E passed. Tests cover source coverage, Unicode
positions, score/threshold consistency, feature contributions, cancellation,
read-only analysis, missing-model UI, download retry and persisted report rendering.
Python coverage/alignment tests and the real tokenizer Unicode checks also passed.

`bun run build:release` produced the app and DMG. `hdiutil verify` confirmed DMG
integrity; this is not a notarization check. UI previews were inspected at narrow
sidebar width. Verification screenshots/logs are under
`build/verification/detectorscope/` (ignored build output).

The model's P(AI) is not established real-world authorship probability. Korean and
academic manuscripts are not independently calibrated. Long documents are split
into independent windows to avoid the upstream 1,024-token truncation. The UI
explains these limits and does not invent an aggregate document probability.

## Citation exclusion and clear verdict follow-up

- All square-bracket content is removed from inference, including nested and
  multiline ranges. Unclosed opening brackets exclude the remainder. Original
  snapshots and Unicode offsets are retained; highlights cannot enter excluded
  ranges. The minimum token limit is checked after filtering.
- Assistant and saved Activity results show an explicit verdict and number of
  flagged windows, with selectable windows and evidence. A 0–100 score gauge
  shows the real threshold on the same scale (about 62.3). Logits, feature
  contributions, revision and interpretation details are collapsed by default.
- Legacy results have a neutral version notice. They are removed by the next
  `/ai-score` command; manuscript text is never changed.
- Real offline model test with four citation-bearing paragraphs: swapping short
  citekeys for longer multi-key citations produced identical 213-token input
  counts, p_ai 0.7881531715393066, logits and feature contributions. Original
  source coverage and exclusion of citation highlights passed. Reproduce with
  `bun scripts/smoke-ai-detector-citations.ts`.
- Eight Python tests cover nested/unclosed brackets, window boundaries, Unicode
  remapping, crossing-token highlights and short filtered inputs. UI tests cover
  threshold equality, near-threshold rounding, window/feature selection and
  persisted comments. Browser verification at 300px and 340px card widths found
  no horizontal overflow; AI and human evidence and both verdict states were
  exercised. Screenshot: `build/verification/detectorscope/ui/clear-verdict.png`.

## Latest-result command and evidence semantics

- `/ai-score` is the single execution path. Dedicated rescore buttons and retry
  prompts on result cards are removed. A new command removes old score results
  before computing the current text, instead of appending another report.
- Editor score threads are replaced in the persisted collaborative document.
  Superseded running work is cancelled and cannot publish a late result. Reports
  inside mixed discussions are removed without deleting other comments.
- Chat hides superseded detection turns immediately and removes them from SQLite
  history, preserving ordinary conversation. Reopening does not restore old scores.
- Upstream `Feature.highlights` contains token indices and SAE activations;
  descriptions come from the feature table, not an explanation generated for the
  current passage. A token such as “months” or “to” therefore does not itself prove
  a repeated phrase. Model reaction excerpts are now collapsed and nearby excerpts
  merged. Actual repeated 3–12-word sequences are checked independently, excluding
  bracket ranges, and shown at their real occurrences. Without such evidence the
  UI does not recommend changing the highlighted word. It does not promise that
  revising a repeated phrase will reduce the model score.
- Tests cover the months/to mismatch, real repeated phrases, excluded citations,
  comment and chat persistence, unrelated-comment preservation, replacing a running
  job, edited-source rescoring and absence of a separate rescore button.
