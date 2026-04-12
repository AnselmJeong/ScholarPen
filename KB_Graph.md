# Knowledge Base Graph — Implementation Plan

## Goal

Add a Knowledge Graph visualization backed by the `Knowledge_Base/wiki/` directory.
Two sub-features:

1. **Left pane tabs** — split the existing sidebar into **Files** (current FileExplorer) and
   **Knowledge** (tree of concepts / entities / sources; click → open markdown in editor).
2. **KB Graph view** — a split-editor mode where the left half shows a D3.js force graph of the
   wiki and the right half renders the selected node's markdown.  Clicking a node highlights it
   and its immediate neighbours; all other nodes fade.

---

## Architecture Overview

```
Left Pane (new LeftSidebar.tsx)
  ├── tab: Files  →  <FileExplorer>  (unchanged)
  └── tab: Knowledge
        ├── Concepts (49)   ← collapsible section
        ├── Entities  (55)
        └── Sources   (32)
              └── click item → rpc.readTextFile() → open in EditorPaneGroup

Editor Area (App.tsx)
  ├── normal mode   →  <EditorPaneGroup>  (unchanged)
  └── graph mode    →  horizontal split
        ├── left: <KnowledgeGraphPanel> (D3 force graph, resizable)
        └── right: <EditorPaneGroup>    (renders clicked node's md)
```

### Data Flow

```
wiki/*.md files  →  [Bun: kb/graph.ts]  →  getKBGraph() RPC
    ↓
{ nodes: GraphNode[], edges: GraphEdge[] }
    ↓
KnowledgeGraphPanel  →  D3 force simulation
    ↓ node click
openFile(node.filePath)  →  EditorArea renders markdown
```

---

## Phase 0 — Preparation

### 0-A  Install D3

```bash
bun add d3
bun add -d @types/d3
```

D3 v7 is the target (ESM-compatible, works with Vite).

---

## Phase 1 — Backend: Graph Data Extraction

### 1-A  New types  (`src/shared/rpc-types.ts`)

```ts
export interface KBGraphNode {
  id: string;          // slug derived from filename, e.g. "dopamine"
  title: string;       // frontmatter title
  type: 'concept' | 'entity' | 'source' | 'overview' | 'other';
  filePath: string;    // absolute path to the .md file
  degree: number;      // number of edges (set after edge extraction)
}

export interface KBGraphEdge {
  source: string;      // node id
  target: string;      // node id
}

export interface KBGraph {
  nodes: KBGraphNode[];
  edges: KBGraphEdge[];
}
```

### 1-B  New RPC method  (`src/shared/scholar-rpc.ts`)

Add to `BunRequests`:

```ts
getKBGraph: {
  params: { projectPath: string };
  result: KBGraph;
};
```

### 1-C  Parser  (`src/bun/kb/graph.ts`)

Responsibilities:
- Walk `<projectPath>/knowledge-base/wiki/` (or detect the global
  `Knowledge_Base/wiki/` path — use the same heuristic as `getKBStatus`).
- For each `.md` file:
  - Extract frontmatter fields: `type`, `title`.
  - Derive `id` from the filename stem (lowercase, hyphens).
  - Collect `[[wikilink]]` occurrences from the body (specifically the
    *Related Pages* section, but scan the whole body for safety).
- Build deduplicated node list and edge list.
- Compute `degree` for each node.
- Return `KBGraph`.

Key regex: `/\[\[([^\]]+)\]\]/g`

Edge target resolution: the wikilink text is the slug (filename stem).
If the target slug is not in the node list, skip the edge (dangling link).

### 1-D  RPC handler  (`src/bun/rpc/handlers.ts`)

```ts
getKBGraph: async ({ projectPath }) => {
  return buildKBGraph(projectPath);
},
```

---

## Phase 2 — Left Pane: Knowledge Tab

### 2-A  New component: `src/renderer/components/sidebar/KnowledgeTree.tsx`

Props:
```ts
interface KnowledgeTreeProps {
  projectPath: string;
  onFileSelect: (filePath: string) => void;
}
```

Behaviour:
- On mount, calls `rpc.getKBGraph({ projectPath })` to get all nodes.
- Groups nodes by type into collapsible sections: Concepts, Entities, Sources, Other.
- Shows count badge per section.
- Each item is clickable → calls `onFileSelect(node.filePath)`.
- Highlights the currently open file.
- Simple text search/filter input at top.

Styling: matches the existing FileExplorer visual language (Tailwind, Radix Tooltip).

### 2-B  New wrapper: `src/renderer/components/sidebar/LeftSidebar.tsx`

Replaces `<FileExplorer>` in `App.tsx`.  Renders two tabs using a minimal tab bar
(not Radix Tabs — simple `<button>` row with border-bottom indicator to stay lightweight).

```
┌──────────────────────────────────┐
│  Knowledge │ Files               │  ← tab bar
├──────────────────────────────────┤
│                                  │
│  (KnowledgeTree | FileExplorer)  │
│                                  │
└──────────────────────────────────┘
```

Props forwarded from `App.tsx`: all existing `FileExplorer` props plus `projectPath`.

### 2-C  Update `App.tsx`

- Replace `<FileExplorer .../>` with `<LeftSidebar .../>`.
- Pass through the existing `onFileSelect` / `activeFile` / project props.

---

## Phase 3 — KB Graph Panel

### 3-A  New component: `src/renderer/components/graph/KnowledgeGraphPanel.tsx`

Props:
```ts
interface KnowledgeGraphPanelProps {
  graph: KBGraph;
  selectedNodeId: string | null;
  onNodeClick: (node: KBGraphNode) => void;
}
```

#### D3 Force Simulation Setup

```ts
const simulation = d3.forceSimulation(nodes)
  .force('link',    d3.forceLink(edges).id(d => d.id).distance(80))
  .force('charge',  d3.forceManyBody().strength(-200))
  .force('center',  d3.forceCenter(width / 2, height / 2))
  .force('collide', d3.forceCollide(d => nodeRadius(d) + 4));
```

#### Node Sizing

```ts
const nodeRadius = (n: KBGraphNode) => Math.sqrt(n.degree + 1) * 5 + 4;
// min ~6px, scales up with connectivity
```

#### Node Colour by Type

| type     | fill       |
|----------|------------|
| concept  | `#6366f1`  (indigo) |
| entity   | `#f59e0b`  (amber) |
| source   | `#10b981`  (emerald) |
| other    | `#94a3b8`  (slate) |

#### Selection / Fade Logic

When `selectedNodeId` is set:
- Build a `Set<string>` of the selected node's immediate neighbours (from edges).
- For each node: `opacity = (id === selectedNodeId || neighbours.has(id)) ? 1.0 : 0.15`.
- For each edge: `opacity = (source === selectedNodeId || target === selectedNodeId) ? 0.8 : 0.05`.
- Highlighted edges get a slightly thicker stroke (`strokeWidth: 1.5 → 2.5`).
- Apply via D3 `.attr('opacity', ...)` on tick / selection change (React re-render with
  useEffect watching `selectedNodeId`).

#### Interactivity

- Zoom & pan: `d3.zoom()` attached to the SVG.
- Node click: calls `onNodeClick(node)` → parent sets `selectedNodeId` and opens file.
- Node drag: standard D3 drag behaviour (`alphaTarget(0.3)` on drag start).
- Hover tooltip: small `<title>` element on each `<circle>` (native SVG tooltip).

#### React Integration

Use a `useRef<SVGSVGElement>` and run all D3 mutations inside a `useEffect`.
On `graph` prop change: re-initialise simulation.
On `selectedNodeId` change only: update opacities without restarting simulation.

#### Legend

Small fixed-position legend (bottom-left of the panel) showing the four node type colours.

### 3-B  Graph mode state in `App.tsx`

Add state:
```ts
const [graphMode, setGraphMode] = useState(false);
const [graphSelectedNode, setGraphSelectedNode] = useState<KBGraphNode | null>(null);
const [kbGraph, setKbGraph] = useState<KBGraph | null>(null);
```

Toggle `graphMode` from a button in the `LeftSidebar` Knowledge tab header (or a toolbar button).
When entering graph mode: call `rpc.getKBGraph(...)` and store result in `kbGraph`.

#### Layout in graph mode

Replace the centre pane with a horizontal split using a draggable divider (same resize
mouse-drag pattern already used for the AI sidebar):

```
┌──────────────────────────────────────────────────────────┐
│ LeftSidebar │ KnowledgeGraphPanel  │▌│ EditorPaneGroup   │
└──────────────────────────────────────────────────────────┘
                ←── graphPanelWidth ──→
```

`graphPanelWidth` default: `420px`; min: `280px`; max: `60vw`.

#### Node click handler

```ts
const handleGraphNodeClick = (node: KBGraphNode) => {
  setGraphSelectedNode(node);
  editorPaneGroupRef.current?.openFile(node.filePath);
};
```

---

## Phase 4 — Polish

### 4-A  KnowledgeTree "Open in Graph" button

In the `LeftSidebar` Knowledge tab header, add a small graph icon button that toggles graph mode.

### 4-B  Graph toolbar

Inside `KnowledgeGraphPanel`, add a minimal overlay toolbar:
- **Reset zoom** button.
- **Clear selection** button (clears `selectedNodeId`).
- **Node count** label: `N nodes · M edges`.

### 4-C  Keyboard shortcuts

- `Escape` while graph is focused: clear selection (show all nodes at full opacity).
- `Cmd+Shift+G`: toggle graph mode (register in `App.tsx` keydown handler).

---

## File Checklist

| File | Action |
|------|--------|
| `package.json` | add `d3`, `@types/d3` |
| `src/shared/rpc-types.ts` | add `KBGraphNode`, `KBGraphEdge`, `KBGraph` |
| `src/shared/scholar-rpc.ts` | add `getKBGraph` to `BunRequests` |
| `src/bun/kb/graph.ts` | **new** — wiki parser + graph builder |
| `src/bun/rpc/handlers.ts` | add `getKBGraph` handler |
| `src/renderer/rpc.ts` | add mock fallback for `getKBGraph` |
| `src/renderer/components/sidebar/KnowledgeTree.tsx` | **new** |
| `src/renderer/components/sidebar/LeftSidebar.tsx` | **new** — wraps FileExplorer + KnowledgeTree |
| `src/renderer/components/graph/KnowledgeGraphPanel.tsx` | **new** |
| `src/renderer/App.tsx` | replace FileExplorer, add graph mode layout |

---

## Implementation Order

```
Phase 0  →  Phase 1 (backend)  →  Phase 2 (sidebar tabs)
                                  →  Phase 3 (graph panel)
                                  →  Phase 4 (polish)
```

Phases 2 and 3 can be developed in parallel once Phase 1 is done.
Test the data layer first by logging `getKBGraph` output in the browser console.

---

## Open Questions / Future Work

- **Performance**: 136 nodes is fast.  If the wiki grows beyond ~500 nodes consider
  debouncing the simulation or switching to a canvas-based renderer.
- **Edge labels**: currently edges are unlabelled.  Could add short relationship types
  from frontmatter (`related_type` field) in a future iteration.
- **Bidirectional deduplication**: wikilinks are directional but visually the graph should
  show undirected edges (deduplicate A→B and B→A into one edge).
- **Search in graph**: highlight all nodes matching a search term, useful for large wikis.
- **Export graph image**: `d3.select(svgRef.current).node().outerHTML` → download as SVG.
