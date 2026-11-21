# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (build frontend first, then watch bun source)
bun run dev

# Development with Vite HMR (hot reload for renderer changes)
bun run dev:hmr          # runs vite dev server + electrobun concurrently

# Production build
bun run build:release    # vite build && electrobun build --env=release

# Frontend only (hot reload server on port 5173)
bun run hmr
```

> `dist/` must exist before `electrobun dev --watch` starts. `bun run dev` handles this by running `vite build` first. If you see `ENOENT: watch 'dist'`, run `vite build` manually first.

## Architecture

ScholarPen is an Electrobun desktop app for macOS academic writing. It has two processes connected by a typed RPC bridge:

```
Bun Main Process (src/bun/)          React Webview (src/renderer/)
─────────────────────────────         ──────────────────────────────
index.ts           ◄──RPC──►         App.tsx (3-pane layout)
rpc/handlers.ts                       EditorArea.tsx (BlockNote)
ollama/client.ts                      AISidebar.tsx (chat)
citation/client.ts                    LeftSidebar.tsx
fs/manager.ts                         blocks/ (custom block types)
agent/pubmed-search.ts                ai/ollama-transport.ts
```

**Shared types** live in `src/shared/` and are imported by both sides:
- `rpc-types.ts` — `OllamaStatus`, `ProjectInfo`, `CitationMetadata`, etc.
- `scholar-rpc.ts` — the RPC schema (`BunRequests`, `WebviewRequests`)

## RPC Bridge

The RPC schema in `src/shared/scholar-rpc.ts` defines all cross-process calls. Main process registers handlers in `src/bun/index.ts` via `BrowserView.defineRPC<ScholarRPC>()`. The renderer calls them via `src/renderer/rpc.ts`.

Streaming AI responses use a callback pattern: `generateTextStream(model, messages, onChunk)` — Main sends `aiChunk` messages back to the webview incrementally.

`rpc.ts` includes mock fallbacks for browser-only development (when Electrobun is unavailable).

## BlockNote & Custom Blocks

The editor uses a custom schema (`src/renderer/blocks/schema.ts`) extending BlockNote with:

| Block | File | Notes |
|-------|------|-------|
| `math` | `math-block.tsx` | Click-to-edit KaTeX, Enter/Esc to commit |
| `figure` | `figure-block.tsx` | Image + caption + auto-numbering |
| `abstract` | `abstract-block.tsx` | `content: "inline"`, blue left border |
| `citation` (inline) | `citation-inline.tsx` | Amber badge `[@citekey, p. N]` |
| `footnote` (inline) | — | Gray circle, hover tooltip |

Slash menu items (`/math`, `/figure`, `/abstract`, `/ai`) are in `slash-menu-items.tsx`.

BlockNote is 0.57 (core, react, mantine, xl-ai), on the Yjs 13 collaboration path (`@blocknote/core/yjs`, `y-prosemirror` 1.x; the `@blocknote/core/y` path needs the Yjs 14 release candidates and is not used). Since 0.57:
- An editor binds to the Y.Doc only through `withCollaboration({ ...options, collaboration })` from `@blocknote/core/yjs`; a plain `collaboration` option is silently ignored.
- The tracked-change marks (`insertion` / `deletion` / `modification`) are not in the default schema. Every editor whose document can hold suggestions, the headless editor whose schema is shipped to Bun, and test editors register `SuggestionMarksExtension()` (`blocks/suggestion-marks.ts`, built from `@handlewithcare/prosemirror-suggest-changes` specs under xl-ai's extension key, so the two never both load).
- `YjsThreadStore` comes from `@blocknote/core/yjs` and the `User` type from `@blocknote/core`; a seeded document no longer gets an empty trailing block.
- Keep `prosemirror-*`, `@tiptap/core` and `yjs` at one installed copy each (BlockNote needs `prosemirror-model` ≥ 1.25.11, `prosemirror-view` ≥ 1.42.5, `yjs` ≥ 13.6.33); a duplicate `prosemirror-transform` breaks `instanceof` checks between steps and mappings.

## AI Integration

`EditorArea.tsx` uses BlockNote's `AIExtension` with a custom `ClientSideTransport`. The transport (`ai/ollama-transport.ts`) wraps Ollama at `http://localhost:11434/v1` via `@ai-sdk/openai-compatible`.

**Critical**: Never pass `model: null` to `ClientSideTransport` — it causes uncaught crashes. Use `createNoOpTransport()` when Ollama is disconnected.

Transport hot-swapping on Ollama reconnect is handled via TanStack Store closure updates without remounting the editor.

## Collaborative Editing (AI as a peer)

Every open document is a shared Y.Doc; editors and the AI agent are peers of it.

- **Bun** (`src/bun/collab/`): `CollabRegistry` holds one Y.Doc per open document, relays Yjs and awareness updates between editor peers over RPC (`collabOpen/Push/Awareness/Close`, base64 updates), and persists it to `.scholarpen/collab/<document>.ydoc`. The webview ships its ProseMirror schema (`shared/collab/schema-spec.ts`) so Bun can read and edit the Y.Doc without BlockNote or React.
- **Agents** (`src/bun/collab/agent/`): `CollabAgent` answers comment threads for ScholarPen AI, the single AI collaborator (`shared/collab/personas.ts`): every comment saved from the composer is assigned to it, the author's replies in AI threads go back to it unless they chose "I'll handle", and `@ai` still works (the old `@stats` / `@reviewer2` handles and their comment authors map to it); a thread with `scope: "document"` (comments made from the slash menu without a selection, or a passage comment the model widens with `<scope>document</scope>`) is planned over the whole manuscript and edited in batches of paragraphs as one change set; `Reviewer` leaves review comments on sections; `zones.ts` maps per-section trust (Observe / Suggest / AI drafts / Auto) to how edits land and drafts sections from notes. Edits go through `shared/ai-text-protection.ts` markers, a stale check with three-way merge (`text-diff.ts`), and land as tracked suggestions (`@handlewithcare/prosemirror-suggest-changes`) or direct edits undoable via a Y.UndoManager on origin `ai-agent`.
- **Assistant edit hand-off** (`shared/agent-document-edit.ts`, `renderer/ai/document-edit-request.ts`): the Assistant tab never edits a document itself. In general chat with a project open, its system prompt lets the model answer an explicit edit request with a `<scholarpen_edit document="documents/….scholarpen.json">` block holding a self-contained instruction; the sidebar shows it as a quote, opens the document if needed, saves it as a whole-manuscript ScholarPen AI thread (`scope: "document"`, like the slash menu without a selection) and follows the thread to its answer in a banner. The document's edit level, zones and tracked changes apply as for any comment; targets outside the project's `documents/` are refused. The Assistant reads documents (the live snapshot and `@`-mentioned `.scholarpen.json` files) as Markdown-like text from `shared/manuscript-text.ts`, never as block JSON, which is mostly markup; an open document that is also mentioned is sent once.
- **Comment lifecycle**: an AI review claim whose passage the author deleted or rewrote (≥50% of its words, for 20 s) is resolved by `stale-claims.ts`. Resolved and deleted threads are then removed with their comment marks about 5 s later by `resolved-purge.ts` (there is no Resolved tab); only the `dismissedFindings` fingerprints and `resolvedReviewBlocks` survive, so a dismissed finding is never raised again. Coordinated "Ask AI" revisions send open comments only, and withdraw any edit no addressed comment accounts for instead of failing.
- **Renderer** (`src/renderer/collab/`): `openCollabPeer` opens the peer before the editor mounts (first peer seeds from JSON; external JSON changes are reconciled block by block). Comments use BlockNote's `YjsThreadStore` in the same Y.Doc. The Activity tab (`components/sidebar/ActivityPanel.tsx`) shows threads, AI jobs, pending suggestions and work zones. Pending AI suggestions are reviewed in place (`collab/suggestion-review.ts`, `components/editor/SuggestionReviewBar.tsx`): new changes arrive as "strike, then write"; the clean view hides removed text, underlines added text and marks changed paragraphs in the gutter; the bottom bar shows the AI's summary, steps through changes (`collab/suggestion-hunks.ts`, one hunk = adjacent removed/added text of one change set) with the original and Keep/Revert in a popover, and toggles a markup (redline) view.
- **Coordinated revision** (`agent/bulk-comments.ts`, Activity tab "Ask AI"): all open comments are answered in one verified change set. Besides the open manuscript, the model reads the project's other `documents/**/*.scholarpen.json` snapshots and `drafts/` notes (read-only, fitted to a budget by `bulk-sources.ts`) and the `exports/references.bib` library; comments asking for evidence also get candidates from the project's article digests and OpenAlex/CrossRef. Citations are written as `[@citekey]` from the library; a work outside it is written `[@doi:…]` with its title in `newReferences`, verified with CrossRef, appended to references.bib (with a backup) before the text is published, and given its citekey. Unknown or unverifiable citations are removed and reported. `citation-edits.ts` turns new `[@…]` groups into citation nodes, so bibliography cleanup sees them as used.
- **Writing policy** for every AI edit: the document's **edit level** (`shared/collab/writing.ts`, Y.Doc map `writing`: Proofread / Sentence / Structural) is stated in each prompt and enforced by a change-rate gate (paragraph rewrites above 25% / 60% are reported, not applied; humanizer and drafting are exempt; Proofread adds no citations). A coordinated request captures the level in `meta.editLevel`. The project **glossary** (`shared/glossary.ts`, `.scholarpen/glossary.json`) and the other documents' **manuscript map** (`shared/manuscript-map.ts`, `.scholarpen/manuscript-map.json`) are added through `CollabAgentDeps.projectGuide`. The reviewer posts deterministic glossary findings (abbreviation not spelled out at first use, avoided variants) without the severity threshold.
- **Project tab** (`components/sidebar/ProjectPanel.tsx`, `bun/collab/project-writing.ts`): edits the glossary; builds the manuscript map (summary, claims, terms and numbers with exact quotes, cached by text hash) and runs the cross-document consistency check (`agent/project-consistency.ts`: broken `@fig-/@sec-` references, duplicated paragraphs, glossary violations, and model-found contradictions between map items). Both run as background `ProjectJobs` the UI polls; the report is saved to `.scholarpen/consistency-report.json` and issues in open documents are posted once as anchored comments.
- **Decision queue and revision history** (Activity tab): a thread whose AI answer needs the author (a needs-user outcome, or a comment edit whose JSON returns `question`) gets `meta.decision`; `shared/collab/decisions.ts` answers it (thread goes back to the AI) or sends several answers as one coordinated revision. Every AI revision is logged in the Y.Doc map `revisions` (`shared/collab/revision-log.ts`) with comments, responses and before/after text; `decideChangeSet` records accept/reject, and "Export response to reviewers" writes a letter to `exports/`.
- **Review & Revision proposals in the manuscript** (`shared/review-session/proposals.ts`, `bun/review/proposals.ts`, `bun/collab/review-proposals.ts`, `components/editor/ProposalCard.tsx`): `documents/` is the only manuscript; review never makes a manuscript copy. A session's record lives in `.scholarpen/reviews/<id>/` (`SessionStore` moves records from the old root `reviews/` on first use; `workspace/` is removed when a run completes) and its editable letter in `<record>/letter/` (`bun/review/letter.ts`; taken over, by copy, from an old `revisions/<id>/` copy when only that has it). "원고에 수정안 표시" in the Review & Revision workspace (the only way to finish a completed session) stages a completed session's text revisions (applied changes and held-back author checks) in `.scholarpen/review-proposals/<session>.json`; each document places its own as one tracked change set apiece once its editor has loaded (`reviewPlaceProposals`), right after naming the current state in History "심사 수정안 표시 전 (<date> 세션)", recorded in the Y.Doc map `reviewProposals` (never placed twice) and the revision log (`kind: "peer-review"`). The change itself is always drawn in the text as a phrase-level redline (`phraseHunks`: struck original, violet-underlined proposal, in clean or markup mode; older word-level placements are laid out again while untouched), and the margin shows violet "심사 반영" cards (reviewer comment, rationale; floating beside its pin in a narrow margin), apart from the AI's own amber review notes, with Accept, Rewrite (accept, then edit in place), Reject, and "reject and ask AI again" (a thread with `meta.reviewProposal` + `blockId`, no comment mark, answered by the agent for that paragraph only). Once every proposal linked to a reviewer comment is settled, `ResponseSyncScheduler` (`bun/review/manuscript-proposals.ts`, `response-sync.ts`) rewrites that comment's response in the letter's `response.json` from the decisions and the paragraph as it now reads; general comments follow when all proposals are settled. A staged file with `respond: false` (e.g. `origin: "carried"` passages of an earlier submitted revision missing from the manuscript) changes the manuscript only, never a letter. Internal ids or tool notes never reach the letter (a plain template is used instead). A staged session is finished without another review: the workspace shows decide → "답신서 만들기" (rewrites only responses whose decisions or final paragraph changed; "모든 답변 새로 쓰기" forces all) → "답신서 내보내기" (always the same folder per session, `exports/response-<date>-<id8>/`), lists remaining `[저자: …]` notes, and lets the author edit a response in place (`reviewEditResponse`). There are no follow-up sessions, share packages or round manuscript exports; a session finished in an old copy (`editablePath`) only shows and exports its letter, and the old copy-editing chapter view stays only to read such copies. A session made by mistake is deleted from the session list (trash icon, after confirmation): `review/delete-session.ts` moves its record (with the letter), an old `revisions/<id>/` copy and its staged proposals to the macOS Trash (renamed into `~/.Trash` on the home volume, since `/usr/bin/trash` can hang on Google Drive folders) and leaves `documents/` and `exports/` alone; it refuses while the session runs, while its proposals are still undecided in the manuscript, or while its revision copy is open in an editor.
- **Humanizer** (`src/bun/collab/agent/humanize/`): the im-not-ai ("Humanize KR") Korean AI-tell remover, built in. A thread whose author comments match its triggers (`/humanize`, `im-not-ai`, "AI 티", "윤문", "어투…자연스럽게", …) or that comes from the slash menu's "Humanize Korean" item runs it: one diagnosis call (`diagnosis-rules.md`) picks the dominant patterns, then every Korean non-heading paragraph is rewritten in the usual batches with `quick-rules.md` and the diagnosis in the prompt; paragraphs changed by 50% or more are discarded and the reply reports the change rate. `rulebook.ts` is generated: refresh it with `bun run sync:im-not-ai <path/to/im-not-ai>`; never edit it by hand.
- **Version history** (`src/bun/collab/history/`, History tab `components/sidebar/HistoryPanel.tsx`): `CollabHistory` records every change to an open document's Y.Doc as checkpoints in `.scholarpen/history/<document>/` (`index.json` plus one Yjs update per checkpoint in `chunks/<n>.yupd`, carrying only the deletions made since the previous one). A checkpoint closes when the author pauses for 10 s or has typed for 5 min, around each AI job, on Cmd+S, and around accept/reject and restores (`renderer/collab/history-restore.ts` `asCheckpoint`). Changes that leave the accepted text unchanged ride along with the next checkpoint. A version is rebuilt by replaying the chunks up to it. Thinning keeps every checkpoint for 48 h, then one per hour, then one per day, and never folds AI edits, restores, labelled or named versions. Restores replace only the blocks that differ and become checkpoints themselves. A history whose base state the Y.Doc has never seen is archived (`*.orphaned-*`) and a new one starts; renaming or deleting a document moves or deletes its history.
- **Drafting placeholders** (`shared/collab/ai-placeholder.ts`, `renderer/blocks/ai-placeholder-block.tsx`, `zones.ts` `runDraft`): drafting an "AI drafts" section first asks for a plan (`{"paragraphs":[{"intent"}]}`), places one `aiPlaceholder` block per paragraph (intent, state pending/writing, draft id), then writes them one call each, replacing each placeholder with a new paragraph. The author may reword a waiting placeholder's intent or drop it ("빼기"); the loop re-reads the plan before every paragraph. The whole draft is one "undo AI edit" (the undo manager's capture window is held open during the job). Placeholders are written with `ai-meta`, skipped by export, and removed when a draft ends early or when the agent attaches after a restart. A plan that does not parse is treated as prose and inserted at once (the old behaviour).
- **AI authorship** (`shared/collab/ai-authorship.ts`, `renderer/blocks/ai-authored-style.ts`, `renderer/collab/ai-authorship.ts`): the `aiAuthored` BlockNote style marks words the AI wrote: Bun adds it to inserted hunks (`applyBlockRewrite`), drafted paragraphs and review proposals; the renderer adds it in `applyAISelection` (meta `AI_AUTHORED_META`) and, through `AIAuthorshipExtension`, to text arriving locally as a suggested insertion (BlockNote's xl-ai menu). Accepting keeps it; the extension drops it from inline text the author types or pastes (whole-block moves, restores and reconciles keep theirs). AI editing must stay blind to it: `captureBlock`, `applyBlockRewrite` and the inline edit protection read text through `authorshipBlind`, so the mark never splits the per-text-node segments the model rewrites. The editor shows it only with the pane toolbar's "AI-written text" toggle (`authorship-visibility.ts`, `.sp-show-ai-authorship`); export drops it. Tests compare documents with `test-support/authorship.ts` `withoutAuthorship`.
- **Response letter as a document** (`shared/review-session/letter-document.ts`, `bun/review/letter-document.ts`, RPC `reviewOpenLetter`): a completed session's letter can be opened as `documents/response-letters/response-<date>-<id8>.scholarpen.json` (one `letter-<commentId>` heading per comment, the comment in quotes, a `letter-<commentId>-response` heading, then the response). From then on the document is the letter: `currentResponses` overlays its wording wherever it differs from what was written into it (`<letter>/.scholarpen/letter-document.json` keeps that per comment), export reads it, `reviewEditResponse` refuses, and `syncReviewResponses` writes rewritten responses only into sections the author has not changed (live through the Y.Doc as an AI edit when an editor has it open, else into the JSON), reporting the rest as `letterKept`. `isLetterDocument` keeps letters out of the manuscript map, consistency check, Ask AI sources, cross-reference targets, the review document list and auto review.
- The `.scholarpen.json` file is still written by the editor as a snapshot, using `acceptedDocument()` so pending suggestions never reach export or search.
- `SCHOLARPEN_HOME` points a development build at a scratch settings/projects root.

## File System & Project Layout

Projects live under the configured projects root. The default root is `~/ScholarPen`, where `settings.json` is stored beside project folders:
```
my-paper/
├── documents/
│   └── my-paper.scholarpen.json # BlockNote JSON (auto-saved every ~2s)
├── drafts/
├── resources/
│   ├── articles/
│   └── books/
├── figures/
└── exports/
    ├── index.qmd                # Empty first chapter a Quarto book needs (new projects; never overwritten)
    └── references.bib           # Canonical BibTeX file
```

## Quarto export

- `.qmd` export (`renderer/blocks/markdown-serializer.ts`) gives each chapter exactly one H1: an existing H1, else a heading the document opens with (promoted to H1), else the filename-derived title.
- Word renders (`plugins/quarto/main/render.ts`, `docx-tables.ts`): when `_quarto.yml` names no docx `reference-doc`, the render builds one with `quarto pandoc lua docx/reference-doc.lua` (pandoc's own default plus the "ScholarPen Table" style: 1 pt rules above the table, under the header row and under the last row) and passes it with the `docx/ruled-tables.lua` filter on the command line, in a temp folder removed afterwards. The filter skips Quarto's one-cell layout tables around captions and figures (they hold a table or image), so no rule is drawn around a caption. An author's own Word template is left alone. Pandoc does not fill in styles a reference document lacks, which is why the reference document is generated, not shipped.

## Project memory and author learning

- Hindsight uses one durable bank identity per project in `.scholarpen/hindsight.json`. The bank's display name is the project folder name. Do not replace an existing identity when reopening or moving a project.
- Opening a project in the app starts `memory/runtime.ts`'s background sync. Filesystem CRUD and tests must not provision remote banks. `bunfig.toml` preloads `scripts/test-env.ts` to disable the production Hindsight singleton; tests inject a loopback service.
- `renderer/collab/author-learning.ts` records trusted direct typing/IME edits in the shared Y.Doc's `authorEdits` map, coalesced by paragraph. It ignores paste, programmatic and remote AI changes and removes undone observations. Existing accepted/rejected revision records are additional evidence; pending/directly-applied AI revisions and raw manuscript snapshots do not demonstrate author preference.
- `bun/memory/learning.ts` infers conditional preferences with the configured provider. A preference needs evidence from at least three different paragraphs and independent author actions, including a direct edit or explicit author request. The local `.scholarpen/author-preferences.json` keeps preferences and excluded evidence. Project tab shows the interpretations and their sources and lets the author exclude a mistaken interpretation.
- `hindsight-sync.json` persists asynchronous ingestion receipts. Poll for completion after relaunch; source IDs are deterministic so changed observations replace their own records instead of multiplying memories. Automatic source records and the supported preference profile are retained in the same project bank.
- Learned guidance reaches comment/whole-document editing, section drafting, sidebar assistance, inline editing and BlockNote AI. Current instructions, glossary, edit level and scientific accuracy remain authoritative; learned guidance never grants permission to edit outside existing review/trust settings.

## Citation Management

`src/bun/citation/client.ts` resolves DOIs via CrossRef and searches via OpenAlex. Citekey format: `{firstAuthorLastName}{year}{titleFirstWord}` (lowercase, sanitized). BibTeX is built as a string — no external tools needed.

**Check Citations** (Edit with AI popup, shown when the selection has citations) checks whether each cited work supports the sentence that cites it:
- `bun/citation-check/source-index.ts` extracts every PDF under `resources/` once (again only when its size or mtime changes), chunks it (`pdf-text.ts`: page-1 lead, body, bibliography marked `refs` and excluded) and indexes it with FTS5 in `db/citation-sources.sqlite`. The scan runs in the background when a project opens and, debounced, when the watcher sees a PDF under `resources/`. Bib entries are linked to PDFs by a DOI on the first pages plus the title (in the text or file name); a DOI-only match must share most title words, and a PDF that matches another entry more strongly is left to it. The Project tab's "Cited sources" section shows index progress, unreadable PDFs and cited works without a PDF.
- `checker.ts`: `shared/citation-check.ts` pairs each citation with its sentence (a citation right after a full stop belongs to the sentence it closes). One model call writes English search queries; per citation the judge sees the PDF's lead plus the best BM25 passages (one extra search on request), or the OpenAlex abstract (`openalex-abstract.ts`, cached) when there is no indexed PDF. Verdicts: supported / partial / overclaim / contradicted / unsupported / unverifiable, with an issue type, reason, verbatim quotes and a suggested sentence. A verdict whose quotes are not found in the source text becomes unverifiable; abstract-only "unsupported" is shown as "not found in the abstract". Revisable suggestions become one protected rewrite that the result card stages as a tracked change on request.

## Phase Status (from PLAN.md)

- ✅ Phase 0 — Scaffolding (Electrobun, Ollama PoC)
- ✅ Phase 1 — Editor (BlockNote + custom blocks, auto-save, 3-pane layout)
- 🚧 Phase 2 — AI Features (AIExtension + Ollama transport working; sidebar chat done; `/ai` slash items pending)
- 📋 Phase 3 — Citation UX (infrastructure ready; hover UI + citekey suggestion menu pending)
- ✅ Phase 4 — PubMed-first live research search with general-web fallback
- 📋 Phase 5 — Export (Markdown, Quarto `.qmd`, DOCX, PDF)

## Design system (Astryx "Workbench")

- The renderer is themed with Astryx (`@astryxdesign/core`). The app theme is the local `workbench` theme in `src/themes/workbench/` (extends Neutral: indigo accent, system UI font, tighter radii). After editing `workbenchTheme.ts`, rebuild it with `bunx astryx theme build src/themes/workbench/workbenchTheme.ts`; `src/astryx-themes.ts` is generated by `astryx theme add/use`, never edit it by hand. Fonts are deliberately system fonts (no webfont download), so `astryx doctor`'s theme-fonts warning is expected.
- `main.tsx` imports `styles/layers.css` first (`@layer reset, tw-preflight, astryx-base, astryx-theme`), then `global.css`, which loads the Astryx reset/components and keeps Tailwind v3 preflight in `tw-preflight`; app rules stay unlayered. `AstryxRoot` wraps the app in `<Theme>` with the mode taken from the app's `.dark` class.
- App colors are HSL-triplet tokens in `global.css` (`--background` = editor surface, `--sidebar` = chrome, `--primary` = indigo accent), tuned to the Workbench palette; keep them in step with the theme. Chrome helpers: `.workbench-*` classes and `.font-mono-ui`.
- Migration is incremental, one surface at a time, so the generated Astryx block below describes the target, not the current state of every file. Done: title bar, side-panel tabs, Settings (`SettingsPage` with section nav, Claude/Codex connection cards, punctuation policy, extension toggles, DetectorScope setup), all modal dialogs (new project/document, delete confirmation, DOI, export, About, Quarto properties/render/book frame), menus (project picker, file context menu, AI thread menu), title-bar/explorer icon buttons, and the right panels (Activity with its AI, zones, revision-history, decision and comment sections; History; Project with glossary, manuscript map, consistency and cited sources). the Assistant tab (header, thread bar, project bar, Project Memory, messages and citation result cards, composer; the assistant-ui runtime and primitives stay, only their presentation is Astryx). Still Tailwind/shadcn: editor surfaces (inline AI edit panel, suggestion review bar), review workspace, the Quarto Book form body, Author Style panels (`PersonalProfilesPanel`, `AuthorLearningPanel`, shared with the Project tab).
- Side panels compose `components/sidebar/panel-kit.tsx` (`PanelHeader`, `PanelSection` collapsible block, `PanelBlock`, `PanelNote`, `PanelError`, `PanelEmpty`, `PanelQuote`, `PanelActions`) with `size="sm"` Astryx controls: `Badge` for statuses, `SegmentedControl` for filters and levels, `CheckboxInput`, `Selector`, `TextInput`/`TextArea` with hidden labels.
- Every modal uses `components/ui/app-dialog.tsx` (`AppDialog`: Astryx Dialog + DialogHeader title/subtitle + end-aligned footer actions, Cancel before the primary action; `purpose="form"` for dialogs with inputs, `"required"` while work is running). Do not reintroduce a Radix dialog. Menus are Astryx `DropdownMenu` (data `items`, `renderTrigger` for custom triggers) and `ContextMenu` (wraps the row; no hand-positioned menus); a row holds one action, so per-item secondary actions go in a nested `items` flyout. Icon-only buttons are Astryx `Button` with `isIconOnly` and `tooltip` (title bar: `components/ui/toolbar-button.tsx`), not Radix tooltips or `title=`. Astryx keeps a closed dialog's content mounted, so gate effects on `isOpen`, and query `dialog[open]` in tests.
- Settings surfaces (including plugin settings rendered in the `settings` slot) are built from `components/settings/settings-kit.tsx` (`SettingsSection`, `SettingsNote`, `SettingsError`, `ExternalLink`) plus Astryx fields with their own `label`/`description` (`TextInput`, `Selector`, `Switch`, `SegmentedControl` in a `Field`). Fix a component's look in the theme (`components:` in `workbenchTheme.ts`), not with per-use classes.
- Component tests that render Astryx components install the browser environment with `renderer/test-support/dom.ts` (`installDom`, `buttonByText`, `chooseOption`, `selectorTrigger`, `controlByLabel`); to type into an Astryx field, dispatch `input`, `change` and `keyup` like the existing helpers: Astryx needs animation frames and observers, `Selector` is a combobox whose options render in a portal, and disabled Astryx buttons use `aria-disabled`.
- Browser-only design preview: run the renderer with Vite and open `/?demo` for a sample project and manuscript (mocked in `rpc.ts`, never used inside the desktop app).

## Vite Aliases

```ts
"@shared"   → "src/shared"
"@renderer" → "src/renderer"
```

## Ollama

- Base URL: `http://localhost:11434` (hardcoded)
- Default model: `qwen3.5:cloud` (prefers "qwen" models by name match)
- Status polling: every 10 seconds; AI features disabled if disconnected
- Requires `OLLAMA_ORIGINS=*` env var — see `CORS.md`

<!-- ASTRYX:START -->
Astryx v0.7.14 · 174 components
CLI: run every command as `bunx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — start every page from a template, never from scratch:
1. `astryx build "<idea>"` — names the template to scaffold from and the parts it lacks.
2. `astryx template <name> <path>` — scaffold it; keep its frame, gap and padding; replace the content.
3. `astryx template <Block>` for parts it lacks; `astryx component <Name>` to read props before using one.
Changing an existing page? Keep it: skip step 2 and add blocks/components inside its sections.
Before you deliver a build, run `astryx doctor --built <dir>`; don't deliver it if it fails.

RULES:
- No <div> — components handle all layout and spacing.
- Read `astryx docs layout` before changing a template's frame.
- Dense data = rows (Table, List/Item), not Card-wrapped lists. Badge = counts only.
- Style with component props first, then Tailwind utilities backed by tokens. No raw hex/px.
- Palettes and custom colors go through the theme, never :root overrides. Run `astryx theme add <slug>` to import; `theme eject <slug>` only forks source. See `astryx docs theme`.
- SELF-CHECK: re-read the file; replace any style={{…}}, raw <div>/<span>, imported .css/@apply, or hardcoded/arbitrary value (bg-[#fff], p-[13px]) with the component or a token-backed utility.

`astryx help` lists every command. Key ones beyond the workflow:
  search "<query>"   find any component / hook / doc / template
  discover <words>   integrations you could add
  docs <topic>       getting-started, principles, tokens, theme … (`astryx docs` lists all)
  docs cli           commands and API reference
  docs authoring     build an integration package, and every field it holds
  upgrade --from <old version> --apply   run after a dependency bump
<!-- ASTRYX:END -->
