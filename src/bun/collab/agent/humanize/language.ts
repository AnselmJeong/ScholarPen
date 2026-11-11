import type { Node as PMNode } from "prosemirror-model";

import { dominantLanguage } from "../../../../shared/manuscript-language";
export { dominantLanguage, type ManuscriptLanguage } from "../../../../shared/manuscript-language";

/** Read accepted prose only; ignore code, atoms, citation IDs and pending insertions. */
export function manuscriptLanguage(doc: PMNode) {
  const text: string[] = [];
  doc.descendants(node => {
    if (node.type.name === "codeBlock" || node.type.spec.code || (node.isAtom && !node.isText)) return false;
    if (node.isText && !node.marks.some(mark => mark.type.name === "insertion" || mark.type.name === "code")) text.push(node.text!);
    else if (node.isBlock) text.push(" ");
    return true;
  });
  return dominantLanguage(text.join(""));
}
