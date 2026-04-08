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
citation/client.ts                    ProjectSidebar.tsx
fs/manager.ts                         blocks/ (custom block types)
lancedb/poc.ts                        ai/ollama-transport.ts
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

## File System & Project Layout

Projects live in `~/ScholarPen/projects/<name>/`:
```
my-paper/
├── manuscript.scholarpen.json   # BlockNote JSON (auto-saved every ~2s)
├── references.bib               # BibTeX (built programmatically)
├── knowledge-base/papers/       # PDFs (Phase 4)
├── figures/
└── .lance/                      # LanceDB vector store (Phase 4)
```

## Citation Management

`src/bun/citation/client.ts` resolves DOIs via CrossRef and searches via OpenAlex. Citekey format: `{firstAuthorLastName}{year}{titleFirstWord}` (lowercase, sanitized). BibTeX is built as a string — no external tools needed.

## Phase Status (from PLAN.md)

- ✅ Phase 0 — Scaffolding (Electrobun, LanceDB, Ollama PoC)
- ✅ Phase 1 — Editor (BlockNote + custom blocks, auto-save, 3-pane layout)
- 🚧 Phase 2 — AI Features (AIExtension + Ollama transport working; sidebar chat done; `/ai` slash items pending)
- 📋 Phase 3 — Citation UX (infrastructure ready; hover UI + citekey suggestion menu pending)
- 📋 Phase 4 — Knowledge Base RAG (LanceDB PoC done; PDF parsing + hybrid search pending)
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
