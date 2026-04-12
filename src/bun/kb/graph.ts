// Knowledge Base graph builder.
// Walks wiki/{concepts,entities,sources}/*.md, parses frontmatter + [[wikilinks]],
// and returns a deduplicated node/edge graph for the renderer.

import { readdir, readFile } from "fs/promises";
import { join, basename } from "path";
import { existsSync } from "fs";
import type { KBGraph, KBGraphNode, KBGraphEdge } from "../../shared/rpc-types";
import { findKBRoot } from "./search";

const GRAPH_SUBDIRS = ["concepts", "entities", "sources"] as const;

const DIR_TO_TYPE: Record<string, KBGraphNode["type"]> = {
  concepts: "concept",
  entities: "entity",
  sources:  "source",
};

// ── Frontmatter parser ─────────────────────────────────────────────────────────

function parseTypeAndTitle(content: string): { type: string; title: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  let type = "other";
  let title = "";

  if (match) {
    for (const line of match[1].split("\n")) {
      if (type === "other") {
        const m = line.match(/^type:\s*(.+)$/);
        if (m) type = m[1].trim().replace(/['"]/g, "");
      }
      if (!title) {
        const m = line.match(/^title:\s*(.+)$/);
        if (m) title = m[1].trim().replace(/^["']|["']$/g, "");
      }
    }
  }

  // Fallback: first H1
  if (!title) {
    const h1 = content.match(/^#\s+(.+)$/m);
    title = h1?.[1]?.trim() ?? "";
  }

  return { type, title };
}

// ── Wikilink extractor ─────────────────────────────────────────────────────────

function extractWikilinks(content: string): string[] {
  const results: string[] = [];
  // [[target]] or [[target|alias]] — capture target only
  const re = /\[\[([^\]|#\n]+?)(?:\|[^\]]*?)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const raw = m[1].trim();
    if (raw) results.push(raw);
  }
  return [...new Set(results)];
}

// ── Main builder ───────────────────────────────────────────────────────────────

export async function buildKBGraph(projectPath: string): Promise<KBGraph> {
  const kbRoot = await findKBRoot(projectPath);
  if (!kbRoot) return { nodes: [], edges: [] };

  const wikiDir = join(kbRoot, "wiki");
  const nodes: KBGraphNode[] = [];
  // normalized (lowercase) id → node, for edge resolution
  const normToNode = new Map<string, KBGraphNode>();
  // pending links for pass 2
  const pendingLinks: Array<{ sourceId: string; targets: string[] }> = [];

  // ── Pass 1: collect all nodes ──────────────────────────────────────────────
  for (const subdir of GRAPH_SUBDIRS) {
    const dir = join(wikiDir, subdir);
    if (!existsSync(dir)) continue;

    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      const id = basename(file, ".md");
      const filePath = join(dir, file);

      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        continue;
      }

      const { type, title } = parseTypeAndTitle(content);
      const nodeType: KBGraphNode["type"] =
        type === "concept" ? "concept" :
        type === "entity"  ? "entity"  :
        type === "source"  ? "source"  :
        DIR_TO_TYPE[subdir] ?? "other";

      const node: KBGraphNode = {
        id,
        title: title || id,
        type: nodeType,
        filePath,
        degree: 0,
      };

      nodes.push(node);
      normToNode.set(id.toLowerCase(), node);
      pendingLinks.push({ sourceId: id, targets: extractWikilinks(content) });
    }
  }

  // ── Pass 2: resolve edges (deduplication + dangling-link filter) ───────────
  const edgeSet = new Set<string>();
  const edges: KBGraphEdge[] = [];
  const degreeMap = new Map<string, number>();

  for (const { sourceId, targets } of pendingLinks) {
    for (const target of targets) {
      const normTarget = target.toLowerCase().trim();
      const targetNode = normToNode.get(normTarget);
      if (!targetNode) continue;           // dangling link — skip
      if (targetNode.id === sourceId) continue; // self-link — skip

      // Bidirectionally deduplicate A→B and B→A
      const key = [sourceId, targetNode.id].sort().join("|");
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);

      edges.push({ source: sourceId, target: targetNode.id });
      degreeMap.set(sourceId, (degreeMap.get(sourceId) ?? 0) + 1);
      degreeMap.set(targetNode.id, (degreeMap.get(targetNode.id) ?? 0) + 1);
    }
  }

  // Assign final degree values
  for (const node of nodes) {
    node.degree = degreeMap.get(node.id) ?? 0;
  }

  return { nodes, edges };
}
