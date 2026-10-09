import type { Node as PMNode } from "prosemirror-model";

export type ManuscriptLanguage = "korean" | "english" | "undetermined";

/** Count words, not bytes or letters: long English words must not outweigh Korean prose. */
export function dominantLanguage(text: string): ManuscriptLanguage {
  let korean = 0, english = 0, other = 0;
  for (const word of text.normalize("NFC").match(/[\p{L}\p{M}]+/gu) ?? []) {
    if (/\p{Script=Hangul}/u.test(word)) korean++;
    else if (/^\p{Script=Latin}[\p{Script=Latin}\p{M}]*$/u.test(word)) english++;
    else other++;
  }
  const total = korean + english + other;
  if (korean > total / 2) return "korean";
  if (english > total / 2) return "english";
  return "undetermined";
}

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
