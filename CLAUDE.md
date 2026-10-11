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

## AI Integration

`EditorArea.tsx` uses BlockNote's `AIExtension` with a custom `ClientSideTransport`. The transport (`ai/ollama-transport.ts`) wraps Ollama at `http://localhost:11434/v1` via `@ai-sdk/openai-compatible`.

**Critical**: Never pass `model: null` to `ClientSideTransport` — it causes uncaught crashes. Use `createNoOpTransport()` when Ollama is disconnected.

Transport hot-swapping on Ollama reconnect is handled via TanStack Store closure updates without remounting the editor.

## Collaborative Editing (AI as a peer)

Every open document is a shared Y.Doc; editors and the AI agent are peers of it.

- **Bun** (`src/bun/collab/`): `CollabRegistry` holds one Y.Doc per open document, relays Yjs and awareness updates between editor peers over RPC (`collabOpen/Push/Awareness/Close`, base64 updates), and persists it to `.scholarpen/collab/<document>.ydoc`. The webview ships its ProseMirror schema (`shared/collab/schema-spec.ts`) so Bun can read and edit the Y.Doc without BlockNote or React.
- **Agents** (`src/bun/collab/agent/`): `CollabAgent` answers comment threads for ScholarPen AI, the single AI collaborator (`shared/collab/personas.ts`): every comment saved from the composer is assigned to it, the author's replies in AI threads go back to it unless they chose "I'll handle", and `@ai` still works (the old `@stats` / `@reviewer2` handles and their comment authors map to it); a thread with `scope: "document"` (comments made from the slash menu without a selection, or a passage comment the model widens with `<scope>document</scope>`) is planned over the whole manuscript and edited in batches of paragraphs as one change set; `Reviewer` leaves review comments on sections; `zones.ts` maps per-section trust (Observe / Suggest / AI drafts / Auto) to how edits land and drafts sections from notes. Edits go through `shared/ai-text-protection.ts` markers, a stale check with three-way merge (`text-diff.ts`), and land as tracked suggestions (`@handlewithcare/prosemirror-suggest-changes`) or direct edits undoable via a Y.UndoManager on origin `ai-agent`.
- **Comment lifecycle**: an AI review claim whose passage the author deleted or rewrote (≥50% of its words, for 20 s) is resolved by `stale-claims.ts`. Resolved and deleted threads are then removed with their comment marks about 5 s later by `resolved-purge.ts` (there is no Resolved tab); only the `dismissedFindings` fingerprints and `resolvedReviewBlocks` survive, so a dismissed finding is never raised again. Coordinated "Ask AI" revisions send open comments only, and withdraw any edit no addressed comment accounts for instead of failing.
- **Renderer** (`src/renderer/collab/`): `openCollabPeer` opens the peer before the editor mounts (first peer seeds from JSON; external JSON changes are reconciled block by block). Comments use BlockNote's `YjsThreadStore` in the same Y.Doc. The Activity tab (`components/sidebar/ActivityPanel.tsx`) shows threads, AI jobs, pending suggestions and work zones.
- **Humanizer** (`src/bun/collab/agent/humanize/`): the im-not-ai ("Humanize KR") Korean AI-tell remover, built in. A thread whose author comments match its triggers (`/humanize`, `im-not-ai`, "AI 티", "윤문", "어투…자연스럽게", …) or that comes from the slash menu's "Humanize Korean" item runs it: one diagnosis call (`diagnosis-rules.md`) picks the dominant patterns, then every Korean non-heading paragraph is rewritten in the usual batches with `quick-rules.md` and the diagnosis in the prompt; paragraphs changed by 50% or more are discarded and the reply reports the change rate. `rulebook.ts` is generated: refresh it with `bun run sync:im-not-ai <path/to/im-not-ai>`; never edit it by hand.
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
    └── references.bib           # Canonical BibTeX file
```

## Citation Management

`src/bun/citation/client.ts` resolves DOIs via CrossRef and searches via OpenAlex. Citekey format: `{firstAuthorLastName}{year}{titleFirstWord}` (lowercase, sanitized). BibTeX is built as a string — no external tools needed.

## Phase Status (from PLAN.md)

- ✅ Phase 0 — Scaffolding (Electrobun, Ollama PoC)
- ✅ Phase 1 — Editor (BlockNote + custom blocks, auto-save, 3-pane layout)
- 🚧 Phase 2 — AI Features (AIExtension + Ollama transport working; sidebar chat done; `/ai` slash items pending)
- 📋 Phase 3 — Citation UX (infrastructure ready; hover UI + citekey suggestion menu pending)
- ✅ Phase 4 — PubMed-first live research search with general-web fallback
- 📋 Phase 5 — Export (Markdown, Quarto `.qmd`, DOCX, PDF)

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
