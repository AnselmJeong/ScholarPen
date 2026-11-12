# Bundled extensions and Author Style (1.12.0)

The source of product scope is `plugin_plan.md`. This release implements Runtime A: trusted, bundled modules. It does not implement an external JavaScript sandbox or independent package installation.

## Baseline and boundaries

The starting version is 1.9.0. `index.ts` combines native application assembly with bibliography, Quarto and detector RPC handlers; `App.tsx` owns Quarto dialogs and state. Live statistics flow through editor/pane/app props. Author learning is scheduled by Hindsight sync. These are the migration seams. Persistent document schemas, collaboration transactions, review/history and canonical `exports/references.bib` remain compatible.

## Implementation sequence

1. Establish existing test/type-check baseline. Add experimental manifest and host contracts with lifecycle tests (medium risk).
2. Move existing feature implementations into six bundled module directories and introduce lazy command routing, retaining deprecated RPC adapters (medium risk).
3. Replace feature UI assembly with extension slots, persistent toggles and error isolation; extract live statistics and Quarto controller (medium risk).
4. Separate local author learning scheduling from remote memory synchronization (medium risk).
5. Run source regression tests, TypeScript checks and stable release build; inspect generated resources and UI (high importance).

The 1.10.0 stages are reviewable in the working diff. Document formats are unchanged. Version 1.11.0 adds a copy-and-validate Author Style migration, described below; the original legacy file remains available for rollback. Extension preferences are stored separately from app settings and manuscripts. No external code is loaded.

Validation commands use the repository's installed dependencies: `bun test ./src`, `bunx tsc --noEmit`, `bun run build:release`. Bare `bun test` also follows packaged Quarto symlinks into external application tests in this workspace; record that separately from the source suite.

## What 1.10.0 implements

| Module | Owned implementation | Integration |
| --- | --- | --- |
| `document-stats` | Unicode segmentation and statistics UI | Status slot; document/selection subscriptions are released on disable. No model or network. |
| `ai-writing-score` | DetectorScope engine, installer, Python sources/locks, setup and result UI | Lazy main entry; the sidebar and comment engine use the same guarded analysis adapter. |
| `text-cleanup` | Unicode analysis, Korean/English Humanize policies and bundled licenses | Inspection command and guarded existing document workflows; protected ProseMirror/Yjs application stays in the core. |
| `quarto` | Render/discovery, book/render/property UI and book controller | Toolbar contribution owns dialogs; legacy RPC names forward to the extension gateway. |
| `bibliography` | Citation clients, validation/repair, canonical repository and editor | Toolbar contribution, shared repository, guarded writes, read-only file fallback and unsaved-draft teardown guard. |
| `author-style` | Existing evidence-based learning and panel | Local scheduling is independent of Hindsight. Disabling stops new observation and profile injection; local profiles remain intact. |

The persisted schema, serializer, history word counts and review/suggestion transaction model remain core contracts. Statistics use `Intl.Segmenter`, omit pending insertions, code and inline atoms, and label whitespace counts separately. They do not replace history accounting.

### Platform layout

- `src/shared/extensions/contracts.ts`: experimental API `0.1.0`, manifest/input/output validation and public lifecycle DTOs.
- `src/shared/extensions/host.ts`: command ownership, lazy activation, failure cleanup, concurrency limits, cancellation signals and safe disable.
- `src/bun/extensions/runtime.ts`: app-owned catalog, atomic preference persistence and host-only leases for legacy workflows.
- `src/renderer/extensions/`: shared slots, error boundaries, enablement state and Settings UI.
- `src/plugins/<module>/scholarpen.plugin.json`: declarative metadata; main/UI entrypoints are generated from the trusted source tree.
- `scripts/generate-plugin-catalog.ts`: generates main loaders, renderer loaders and legacy routing. Build/dev commands generate it; `bun run plugins:check` checks freshness.

New bundled commands and supported slot views are registered by adding a module manifest and its `main.ts`/`ui.tsx`, then regenerating the catalog. Modules that need host operations also declare their narrow service object in `bun/extensions/services.ts`. Neither `App.tsx` nor `index.ts` needs a feature implementation import. A command's input must match its manifest schema before activation. Responses are checked against the declared output schema; existing domain validators still enforce detailed report and bibliography semantics. Duplicate request IDs are rejected for a bounded five-minute window rather than replaying a write.

Preferences are stored in `${SCHOLARPEN_HOME || ~/ScholarPen}/extensions.json`, version 1. Existing users default to all six modules enabled. A damaged preference file disables extensions for that session without blocking the document shell. Settings toggles persist immediately. Disabling a running non-abortable operation is rejected until it finishes; an unsaved bibliography draft must be saved or discarded first. Uninstallation/data migrations are not part of this release.

## Explicit migration seams and remaining plan work

This is the **existing-feature modularization release**, not a claim that all P0–P6 checkboxes in `plugin_plan.md` are complete.

- `LegacyExtensionServices` has been removed in 1.11.0. Each generated loader now passes a module-specific service object. Legacy RPC names survive only in the generated gateway and shared compatibility types. These narrow contracts are for trusted modules and do not isolate malicious in-process code.
- `fs/bibliography-adapter.ts` retains legacy filesystem methods for agent/review callers. Canonical read access and startup migration remain available to core compatibility code. Writes check enablement.
- The collaboration agent still owns thread/result lifecycle, Humanize batching and review application. It holds extension task leases while feature work runs. Generic document-action, result-renderer, file-handler and skill/tool registries remain planned; current legacy entrypoints are intentionally preserved.
- Some compatibility UI/policy helpers still load with the editor. Lazy generated entrypoints do not imply that every disabled feature byte has been removed from startup bundles. No startup-performance target is claimed.
- Author Style now provides local profiles, private samples/evidence, migration, editable rules, comparisons and a common context provider. Real-corpus paired quality evaluation remains a user evaluation task, not a claimed model-quality score.
- Project-scoped opaque handles, comprehensive network/process brokers, resumable jobs, generic service version negotiation and durable idempotency are not implemented by the experimental gateway.
- Existing skills remain compatible through the existing skill registry. P5's typed skill runner and the remaining research/review/provider module migration are separate work.
- External JS installation, sandboxing, signature verification, independent updates and a marketplace (P6) are not exposed. Only trusted compile-time catalog entries can run.

The next architectural step is moving the remaining collaboration and file/result adapters onto shared contribution contracts. This should happen before presenting the experimental SDK as a third-party API.

## Validation

Baseline: TypeScript passed; `bun test ./src` passed 789 tests with 2 fixture-dependent skips. Bare `bun test` also discovered unrelated external Quarto/Codex tests through workspace links, so `bun run test` targets the repository source suite.

Contract tests cover activation races, failed activation cleanup, schema validation, foreign commands, duplicate requests, disable during a running task, cancellation and failed preference writes. A subprocess integration test uses an isolated `SCHOLARPEN_HOME`, exercises the real catalog and filesystem adapters, disables all six plugins, verifies manuscript/canonical bibliography preservation, and verifies preferences after a fresh process restart. Corrupt preferences are also tested.

Browser preview verification uses the current Vite source at 700 × 650 and 850 × 700: all six extension switches render, Quarto and bibliography toolbar contributions unmount/remount independently, and disabling the detector removes its setup panel. Browser preview uses mock preferences; this is separate from native persistence verification.

Final checks (2026-11-11): **802 passed, 2 fixture-dependent skips, 0 failures** across 133 source test files; `bunx tsc --noEmit`, catalog freshness and `git diff --check` passed. The stable macOS arm64 release and DMG were produced as version **1.10.0**; `hdiutil verify` reports a valid checksum. All three bundled Humanize/Unicode license notices are present under `Contents/Resources/app/licenses`. Signing and notarization were skipped by the existing build configuration.

Native WKWebView verification used the extracted release app on the local disk with a separate `/tmp/scholarpen-native-smoke` projects/settings root and Hindsight disabled. The test opened a Korean/English document, displayed live statistics, disabled all six modules, edited/saved the document, opened the unchanged canonical bibliography read-only, and re-enabled bibliography/Quarto/statistics. A dirty bibliography entry prevented disable and stayed intact; the test draft was reverted and the smoke app was closed. No installed application or user manuscript was replaced. Real model inference, provider authentication and real Quarto rendering were not re-exercised; their existing source tests remain passing.

Packaging caveat: directly launching Electrobun's self-extracting stable bundle from the external `/Volumes/Aquatope` build directory failed with `RenameAcrossMountPoints` while moving its extraction from Application Support. The generated DMG is valid; native verification used a local copy of its extracted app. The unpacked app was also restored to `build/stable-macos-arm64/ScholarPen.app`. This is a launcher/cross-volume limitation, not a claim that external-volume launch has been fixed.

## 1.11.0: compatibility contracts and Style Studio

The broad `LegacyExtensionServices` injection and the `memory/runtime.ts` AuthorLearning facade are removed. Generated loaders pass separate service objects to each module. Legacy RPC names still route through one generated host adapter, while new Author Style operations use the `scholarpen.author-style.profile` command and the `profile@1` DTO contract. Canonical bibliography reads and existing editor transactions retain their compatibility wrappers.

Style Studio is available in Settings and the project panel. It provides project/language/genre profiles, explicit rules, candidate approval and dismissal, selected TXT/Markdown/Quarto samples or pasted excerpts, evidence inspection/deletion, profile rename/delete, version restore, JSON export/import, strength controls, one-request opt-out and a comparison view. Imports remain candidates until the author approves them. A sample alone can never satisfy the three-independent-edit threshold. Comparisons reject exact training-sample overlap, flag missing numeric/citation/math markers and long copied sample passages, and never modify manuscripts.

Profiles and evidence live in `~/Library/Application Support/dev.scholarpen.app/author-style/` (override: `SCHOLARPEN_PROFILE_HOME`; isolated `SCHOLARPEN_HOME` uses its `.plugins/author-style` directory). Files use atomic writes and mode 0600, the directory uses 0700. Optimistic revision checks prevent stale analysis or another window from overwriting a user change. Migration copies and validates `.scholarpen/author-preferences.json`, retains a private backup and migration hash, preserves project-local observation scope, and never infers remote consent. Existing shared document/history/legacy files are not erased by removing private learning evidence.

New profiles have observation, automatic analysis and remote consent off. Direct trusted typing is coalesced per paragraph and delivered to private storage through the host bridge rather than written into Y.Doc. The five-minute scheduler requires at least ten observations and five minutes without a fresh observation. Sample analysis and comparisons enforce local-only/remote-consent policy in the host. Local-only requires a loopback Ollama endpoint and verifies `/api/show` metadata before submitting any samples, rejecting remote-backed aliases; no remote fallback is attempted. Approved rules can be used without running analysis. Only rules, not raw samples, enter writing prompts.

`bun/ai/context-composer.ts` owns style resolution for inline streams/proxy, sidebar writing, collaboration/section drafts and review revision/author responses. Extraction, search, style learning and reviewer evaluation are excluded, and ordinary chat is opt-in. Historical free-form chat uses a conservative purpose adapter. Existing author punctuation defaults and document protection checks stay active independently of the plugin. The 1.11.0 implementation was project scoped; personal defaults and configurable punctuation follow in 1.12.0 below. Semantic conflict/copy detection and live partial-acceptance learning remain roadmap work.

Hindsight no longer collects or learns Author Style data. Its durable sync ledger retires previously sent automatic author sources. Until deletion completes, retrieval is withheld so deleted/private style material cannot re-enter prompts. The Studio reports pending remote deletion. Manual project notes remain a separate feature. Model-provider inference retention is not represented as remotely deleted by these controls.

Validation on 2026-11-12: **818 passed, 2 fixture-dependent skips, 0 failed** (136 source test files), TypeScript and generated-catalog checks passed. The stable macOS arm64 release is **1.11.0**. Native WKWebView QA used a separate `/tmp/scholarpen-style-qa` project and private storage: created a profile, saved a rule and synthetic sample, confirmed remote analysis was blocked under local-only, disabled/re-enabled the module and verified all profile data survived. No real manuscript or installed app was replaced. Real-provider style quality and the proposed 20-task blind author evaluation remain unmeasured.

## 1.12.0: personal defaults and punctuation preferences

Settings includes a personal profile library even without an open project. Authors can create, rename, edit, delete and restore profiles, choose a global default and bind language/genre defaults. Project profiles can publish explicitly approved rules into a new personal profile; raw examples, observations, evidence IDs and project paths are never copied. Editing a shared personal profile affects linked projects on their next request, without merging their learning evidence. Personal scope rejects automatic observation and sample analysis.

Resolution uses a request's explicit profile first, then the project's selected profile or personal link, then a matching language/genre default, then the personal global default. Exact language takes priority over a genre-only wildcard binding. Language or genre mismatch and deleted explicit links return no style rather than silently substituting another profile. Project settings expose the writing genre and an automatic-default option. The editor status displays the effective profile or a mismatch notice. Strength, skip-next and chat opt-in remain project scoped; extraction/evaluation remain excluded.

`personal.json` lives beside the private project profile files and uses the same local author ID, atomic writes and 0600 permissions. It has its own optimistic revision, a bounded profile history and validated default bindings. Deleting a personal profile removes its global/default bindings while leaving explicit project links visible as missing. No user manuscript migration is needed; older project configuration receives the academic genre default on read.

Punctuation preferences are a core setting independent of Author Style. Em dashes and semicolons each offer **avoid** or **allow**, defaulting to the prior avoid/avoid behavior. Settings save immediately; `writing-preferences.json` uses a separate revision and atomic 0600 storage under `~/Library/Application Support/dev.scholarpen.app/` (or `SCHOLARPEN_PROFILE_HOME`, then `SCHOLARPEN_HOME`). A stale save reloads the current values rather than overwriting them. Corrupt data is reported and preserved.

The common composer and provider adapters resolve punctuation placeholders once, retaining the policy captured by the writing request. Inline preview/apply, Deepen/citation revisions and collaboration block edits carry that snapshot into protected output correction, so changing settings cannot reinterpret an existing suggestion. Source quotations, code fences, math, URLs, citation lists, control markers, ranges and hyphens retain their protection. Allowing punctuation disables the corresponding deterministic replacement. Comparisons use the same punctuation policy for baseline and styled output. Disabling Author Style stops its rules and observations while preserving explicit punctuation preferences.

Source validation on 2026-11-12: **835 passed, 2 fixture-dependent skips, 0 failed** across 139 files. TypeScript, generated-catalog freshness and whitespace checks passed. Tests cover default precedence, author isolation, private rules-only publication, language/genre mismatch, restore/deletion, corrupt/stale storage, process restart and plugin disable, settings UI, request snapshots and protected punctuation.

The stable macOS arm64 **1.12.0** bundle and DMG were built; `hdiutil verify` passed. Native WKWebView QA used `/tmp/scholarpen-global-qa` with separate projects/private storage. Without opening a project, it created a personal profile and explicit rule, selected its Korean academic default, disabled Author Style, restarted and re-enabled it, and verified the rule/default survived. A stored allow-em-dash/avoid-semicolon fixture loaded correctly while the module was disabled. Native select-menu automation was unreliable, so direct dropdown-save clicks were not claimed as verified: independent saves/conflict recovery were checked in rendered React tests, persistence and disabled-plugin behavior in store/process integration tests. The native fixture was written through the same store before restart. No installed app or real manuscript was replaced; no real-provider prose-quality evaluation was performed.
