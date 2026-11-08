import * as Y from "yjs";
import { COLLAB_FRAGMENT } from "./protocol";

/** Stable content only: review maps and comment anchors do not change the manuscript. */
export function manuscriptFingerprint(doc: Y.Doc): string {
  const sorted = (attributes: Record<string, unknown>) => Object.fromEntries(
    Object.entries(attributes).filter(([key]) => key !== "comment").sort(([a], [b]) => a.localeCompare(b)),
  );
  const visit = (node: Y.XmlElement | Y.XmlText | Y.XmlHook): unknown => {
    if (node instanceof Y.XmlHook) return { hook: node.hookName, value: sorted(node.toJSON()) };
    if (!(node instanceof Y.XmlText)) return { type: node.nodeName, attributes: sorted(node.getAttributes()), children: node.toArray().map(visit) };
    const parts: { insert: unknown; attributes: Record<string, unknown> }[] = [];
    for (const part of node.toDelta()) {
      const attributes = sorted(part.attributes ?? {});
      const last = parts.at(-1);
      if (last && typeof last.insert === "string" && typeof part.insert === "string" && JSON.stringify(last.attributes) === JSON.stringify(attributes)) last.insert += part.insert;
      else parts.push({ insert: part.insert, attributes });
    }
    return parts;
  };
  return JSON.stringify(doc.getXmlFragment(COLLAB_FRAGMENT).toArray().map(visit));
}
