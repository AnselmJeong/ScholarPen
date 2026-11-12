import type { Node as PMNode } from "prosemirror-model";
/** Read-only accepted prose projection. Positions remain those of the live document. */
export function acceptedText(doc: PMNode, from = 0, to = doc.content.size): string {
  const lines: string[] = [];
  let line = "";
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.spec.code || node.type.name === "codeBlock") return false;
    if (node.isTextblock) { if (line) lines.push(line); line = ""; }
    if (node.isText && !node.marks.some(mark => mark.type.name === "insertion" || mark.type.name === "code")) {
      line += node.text!.slice(Math.max(0, from - pos), Math.min(node.nodeSize, to - pos));
    }
    return true;
  });
  if (line) lines.push(line);
  return lines.join("\n");
}
