# ScholarPen: Tiptap Migration Plan

## Goal

Replace the BlockNote editor with Tiptap to gain:
- Native `BubbleMenu` for inline AI editing (select text → Ask AI → stream → accept/reject)
- Full ProseMirror-level selection/transaction control
- Cleaner `tiptap-markdown` round-trip for `.md`/`.qmd` export
- Decoupled AI integration (no dependency on `@blocknote/xl-ai`)

The **Bun process, RPC bridge, and file system are unchanged.**
The current `src/renderer/` is **frozen as reference — never deleted.**

---

## Guiding Principles

1. Parallel development: new renderer lives in `src/renderer-tip/`
2. Both renderers share `src/shared/` types; RPC client is re-exported
3. Switch is a single Vite config change (`vite.tip.config.ts`)
4. Ship in phases — each phase ends at a working, testable state
5. No BlockNote packages removed until Phase T5 cutover

---

## Directory Structure

```
src/
  bun/              ← unchanged
  shared/           ← unchanged (RPC types + schema)
  renderer/         ← frozen (BlockNote reference)
  renderer-tip/     ← NEW
    index.html
    main.tsx
    rpc.ts          ← re-exports ../renderer/rpc.ts verbatim
    App.tsx         ← 3-pane shell (reuses FileExplorer, AISidebar, StatusBar)
    editor/
      TiptapEditor.tsx        ← useEditor + autosave + word count
      extensions/
        MathNode.tsx           ← KaTeX display block (atom, NodeView)
        FigureNode.tsx         ← image + caption + numbering (atom, NodeView)
        AbstractNode.tsx       ← styled container (content: "block+", NodeView)
        CitationNode.tsx       ← inline amber badge (inline atom, NodeView)
        FootnoteNode.tsx       ← inline footnote marker (inline atom, NodeView)
        SlashCommands.ts       ← @tiptap/suggestion-based slash menu
      ai/
        AIBubbleMenu.tsx       ← core AI interaction surface
        useAIStream.ts         ← direct-fetch Ollama streaming hook
    components/
      sidebar/                 ← AISidebar, FileExplorer reused with minimal edits
      editor/                  ← StatusBar, ExportDialog reused
      settings/                ← SettingsPage reused unchanged
      ui/                      ← shadcn components (shared from renderer/)
    styles/
      global.css               ← identical Tailwind + CSS vars
    serialization/
      markdown.ts              ← tiptap-markdown config + per-block serializers
```

---

## Packages to Add

```bash
bun add \
  @tiptap/react \
  @tiptap/starter-kit \
  @tiptap/extension-bubble-menu \
  @tiptap/extension-image \
  @tiptap/extension-character-count \
  @tiptap/extension-placeholder \
  @tiptap/extension-underline \
  @tiptap/extension-text-align \
  @tiptap/suggestion \
  tiptap-markdown
```

`@tiptap/extension-mathematics` is a candidate for inline `$...$` math; block-level display math still needs a custom Node regardless, so it is listed as optional.

**BlockNote packages are NOT removed yet.**

---

## Document Format

| Format             | Extension          | Renderer    | Notes                           |
|--------------------|--------------------|-------------|---------------------------------|
| BlockNote JSON     | `.scholarpen.json` | renderer/   | Frozen; no new files created    |
| Tiptap PM JSON     | `.tip.json`        | renderer-tip| New documents only              |

Action required in `src/bun/fs/manager.ts`:
- Add `.tip.json` to `extToKind()` → kind `"document"`
- No other FS changes needed

---

## Custom Block → Tiptap Extension Mapping

| BlockNote block      | Tiptap type               | Key attributes                              |
|----------------------|---------------------------|---------------------------------------------|
| `math`               | Block Node (atom)         | `atom: true`, ReactNodeViewRenderer, KaTeX  |
| `figure`             | Block Node (atom)         | `atom: true`, ReactNodeViewRenderer, image + caption |
| `abstract`           | Block Node (container)    | `content: "block+"`, ReactNodeViewRenderer  |
| `citation` (inline)  | Inline Node (atom)        | `inline: true, atom: true`, amber badge     |
| `footnote` (inline)  | Inline Node (atom)        | `inline: true, atom: true`, hover tooltip   |

All custom Nodes use `ReactNodeViewRenderer` — same React component logic as current BlockNote specs.

Slash commands via `@tiptap/suggestion`: `/math`, `/figure`, `/abstract`, `/ai`.

---

## AI BubbleMenu Design

### Interaction flow

```
① Text selected in editor
         ↓
② BubbleMenu appears — formatting bar + "✦ Ask AI" button
   ┌────────────────────────────────────────────────────┐
   │  B  I  U  ~~  `  H1 H2 H3  [Link]  │  ✦ Ask AI   │
   └────────────────────────────────────────────────────┘
         ↓ (click ✦ Ask AI)
③ BubbleMenu expands with quick-action chips + freeform input
   ┌────────────────────────────────────────────────────┐
   │  [Improve]  [Summarize]  [Translate]  [Expand]    │
   │  ─────────────────────────────────────────────    │
   │  ✦  Rewrite this more concisely...          [↵]  │
   └────────────────────────────────────────────────────┘
         ↓ (submit)
④ Original selection is visually dimmed; streamed response
   appears inside BubbleMenu as it arrives
   ┌────────────────────────────────────────────────────┐
   │  The trust game is a repeated interaction where…   │
   │  [Accept ↵]   [Reject Esc]   [Retry ⌘↵]          │
   └────────────────────────────────────────────────────┘
         ↓ (Accept)
⑤ editor.chain().deleteRange(savedRange).insertContent(result).run()
```

### Implementation sketch

```tsx
// useAIStream.ts — reuses direct-fetch pattern established in AISidebar
export function useAIStream() {
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const run = async (model: string, messages: OllamaMessage[]) => {
    setResult(""); setLoading(true);
    abortRef.current = new AbortController();
    const res = await fetch("http://localhost:11434/api/chat", {
      method: "POST", signal: abortRef.current.signal,
      body: JSON.stringify({ model, messages, stream: true, think: false }),
    });
    // stream → accumulate → setResult
  };

  return { result, loading, run, abort: () => abortRef.current?.abort() };
}

// AIBubbleMenu.tsx
<BubbleMenu editor={editor} shouldShow={({ state }) => !state.selection.empty}>
  {aiOpen ? (
    <AIPanel
      selectedText={editor.state.doc.textBetween(from, to)}
      onAccept={(text) =>
        editor.chain().focus().deleteRange({ from, to }).insertContent(text).run()
      }
    />
  ) : (
    <FormattingBar onAIClick={() => setAiOpen(true)} />
  )}
</BubbleMenu>
```

---

## Vite Config Strategy

New file `vite.tip.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@":       path.resolve(__dirname, "src/renderer-tip"),
    },
  },
  root: "src/renderer-tip",
  build: { outDir: "../../dist", emptyOutDir: true },
  define: {
    "process.env":      JSON.stringify({}),
    "process.version":  JSON.stringify("v18.0.0"),
    "process.platform": JSON.stringify("browser"),
  },
});
```

New `package.json` scripts:

```json
"dev:tip":     "vite build --config vite.tip.config.ts && electrobun dev --watch",
"hmr:tip":     "vite --config vite.tip.config.ts --port 5174",
"build:tip":   "vite build --config vite.tip.config.ts && electrobun build --env=release"
```

Existing `dev` / `hmr` / `build:release` scripts remain untouched.

---

## Implementation Phases

### Phase T1 — Scaffolding
**Goal:** App boots with a bare Tiptap editor; text persists across restart.

- [ ] Install Tiptap packages
- [ ] Create `src/renderer-tip/` skeleton (index.html, main.tsx, App.tsx, global.css)
- [ ] `vite.tip.config.ts` + scripts in `package.json`
- [ ] `rpc.ts` re-export (wire Electrobun bridge)
- [ ] `TiptapEditor.tsx` with `StarterKit` + `CharacterCount`
- [ ] 2s debounce autosave via `onUpdate` → `rpc.saveDocument` (`.tip.json`)
- [ ] Add `.tip.json` → `"document"` kind in `fs/manager.ts`
- [ ] Load document on project/file change

### Phase T2 — Custom Blocks
**Goal:** All ScholarPen block types creatable and survive save/load.

- [ ] `MathNode` — KaTeX display block, click-to-edit (port from `math-block.tsx`)
- [ ] `FigureNode` — image upload + caption + auto-numbering (port from `figure-block.tsx`)
- [ ] `AbstractNode` — blue-bordered container block (port from `abstract-block.tsx`)
- [ ] `CitationNode` — inline amber badge (port from `citation-inline.tsx`)
- [ ] `FootnoteNode` — inline footnote with hover tooltip (port from `citation-inline.tsx`)
- [ ] `SlashCommands` extension — `/math`, `/figure`, `/abstract`, `/ai` items
- [ ] `serialization/markdown.ts` — custom block rules for `tiptap-markdown`

### Phase T3 — AI BubbleMenu
**Goal:** Select text → Ask AI → streamed response replaces selection.

- [ ] `useAIStream` hook (model, messages → streaming result + loading + abort)
- [ ] `FormattingBar` sub-component (Bold/Italic/Underline/Strike/Code/H1-H3/Link)
- [ ] `AIPanel` sub-component (quick actions + freeform input + streaming preview)
- [ ] `AIBubbleMenu` wiring `FormattingBar` ↔ `AIPanel`
- [ ] Accept (Tab / Enter) and Reject (Esc) keyboard bindings
- [ ] `editor.setEditable(false)` during generation to prevent cursor fights

### Phase T4 — Feature Parity
**Goal:** New renderer is fully usable as daily driver.

- [ ] 3-pane App.tsx (FileExplorer + TiptapEditor + AISidebar)
- [ ] AISidebar reused unchanged
- [ ] SettingsPage reused unchanged
- [ ] StatusBar with word count (`CharacterCount.getWords()`)
- [ ] ExportDialog — markdown via `tiptap-markdown` + Quarto YAML frontmatter
- [ ] Import markdown → Tiptap blocks
- [ ] Cmd+S explicit save, menu action wiring
- [ ] FileViewer unchanged

### Phase T5 — Cutover (after T4 stabilises)
- [ ] Point `dev` script at `vite.tip.config.ts`
- [ ] Provide `.scholarpen.json` → `.tip.json` conversion utility
  (BlockNote JSON → extract plain text → import via `tiptap-markdown`)
- [ ] Update `CLAUDE.md` to reflect new architecture
- [ ] Archive `src/renderer/` (keep but no longer built)

---

## Risk Register

| Risk | P | I | Mitigation |
|------|---|---|------------|
| `tiptap-markdown` can't serialize custom Nodes | M | M | Write per-Node `addStorage` serializers; logic already in `markdown-serializer.ts` |
| Slash command UX regression | L | L | `@tiptap/suggestion` is well-documented; copy current item list exactly |
| BubbleMenu / cursor focus fights during AI stream | M | M | `editor.setEditable(false)` during generation; save `from/to` positions before streaming starts |
| Electrobun RPC bootstrap fails in new renderer | L | H | `rpc.ts` is identical to current; verify `Electroview` initialises under `src/renderer-tip/` |
| Abstract block's nested content complicates serialization | M | M | Treat as a fenced div in `tiptap-markdown` (`::: abstract … :::`) matching current `.qmd` export |
| `.tip.json` ↔ `.scholarpen.json` coexistence confusion in file tree | L | L | Different extensions, different kind entries — FS manager handles both transparently |
| ProseMirror NodeView performance with many blocks | L | L | ReactNodeViewRenderer performance is equivalent to BlockNote's React blocks |

---

## Open Questions (resolve before Phase T2)

1. **`@tiptap/extension-mathematics`** — does it cover display-mode (block) equations, or inline only? If inline only, `MathNode` must be fully custom.
2. **`tiptap-markdown` version compatibility** — confirm it targets `@tiptap/core ^2.x` (current Tiptap is 2.x).
3. **Abstract block nesting** — decide whether nested blocks inside Abstract are full ProseMirror blocks or just inline content (affects serialization and UX).
4. **Citation UX** — current BlockNote citation is inserted manually; plan for Phase T4 whether to keep manual insertion or add the hover-search UI.

---

*Last updated: 2026-04-10*
