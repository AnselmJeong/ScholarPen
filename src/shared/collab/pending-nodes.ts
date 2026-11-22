import type { Mark, Node as PMNode, Schema } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { leafText } from "./schema-spec";

/**
 * Inline nodes (citations, equations, cross-references, footnotes) that a
 * pending AI suggestion removes or adds. y-prosemirror syncs only attributes
 * for inline element nodes, so a citation node cannot carry its `deletion` or
 * `insertion` mark through the Y.Doc. While the suggestion is pending, the
 * node is written as text that reads like it (`[@kim2020]`, `$a$`) and holds
 * the node in this mark, and the text carries the suggestion mark instead.
 * Once the author keeps or reverts the suggestion, `settlePendingNodes` turns
 * the text that stays (a reverted removal, a kept addition) back into the node.
 */
export const PENDING_NODE_MARK = "pendingNode";

const SUGGESTION_MARKS = new Set(["insertion", "deletion"]);

/** Text standing in for the inline leaf `node` while a suggestion adds or removes it. */
export function pendingNodeText(node: PMNode, marks: readonly Mark[] = []): PMNode {
  const schema = node.type.schema;
  const type = schema.marks[PENDING_NODE_MARK];
  if (!type) throw new Error("The schema has no pendingNode mark.");
  // A key of its own, so two identical neighbours never merge into one text node.
  const json = JSON.stringify({ type: node.type.name, attrs: node.attrs, key: Math.random().toString(36).slice(2, 10) });
  return schema.text(leafText(node) || " ", type.create({ node: json }).addToSet(marks));
}

function standInNode(schema: Schema, json: string): PMNode | null {
  try {
    const { type, attrs } = JSON.parse(json) as { type?: string; attrs?: Record<string, unknown> };
    const nodeType = type ? schema.nodes[type] : undefined;
    return nodeType?.isInline && nodeType.isLeaf ? nodeType.create(attrs) : null;
  } catch {
    return null;
  }
}

/**
 * Turns every stand-in that no longer belongs to a pending suggestion back
 * into its node. Returns true when it changed anything.
 */
export function settlePendingNodes(tr: Transform): boolean {
  const schema = tr.doc.type.schema;
  const type = schema.marks[PENDING_NODE_MARK];
  if (!type) return false;
  const runs: Array<{ from: number; to: number; json: string }> = [];
  tr.doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    const mark = node.isText ? type.isInSet(node.marks) : undefined;
    if (!mark || node.marks.some((item) => SUGGESTION_MARKS.has(item.type.name))) return false;
    // Other marks (a comment) may split one stand-in into several text nodes.
    const last = runs.at(-1);
    if (last && last.to === pos && last.json === mark.attrs.node) last.to = pos + node.nodeSize;
    else runs.push({ from: pos, to: pos + node.nodeSize, json: String(mark.attrs.node) });
    return false;
  });
  for (const run of runs.reverse()) {
    const node = standInNode(schema, run.json);
    if (node) tr.replaceWith(run.from, run.to, node);
    else tr.removeMark(run.from, run.to, type);
  }
  return runs.length > 0;
}

/** `doc` with its settled stand-ins turned back into nodes (after accepting or reverting suggestions offline). */
export function withPendingNodesSettled(doc: PMNode): PMNode {
  const tr = new Transform(doc);
  return settlePendingNodes(tr) ? tr.doc : doc;
}
