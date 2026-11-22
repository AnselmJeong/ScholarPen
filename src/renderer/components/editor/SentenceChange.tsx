import React from "react";
import { diffParts } from "../../../shared/collab/history";
import { sentenceSpans } from "../../../shared/collab/sentences";
import type { SuggestionHunk } from "../../collab/suggestion-hunks";

export type SentenceChangeKind = "revised" | "added" | "removed";

export function sentenceChangeKind(hunk: Pick<SuggestionHunk, "before" | "after">): SentenceChangeKind {
  return !hunk.before ? "added" : !hunk.after ? "removed" : "revised";
}

/** "Sentence revised", "Sentences added", … for a card or popover heading. */
export function sentenceChangeLabel(hunk: Pick<SuggestionHunk, "before" | "after">) {
  const count = Math.max(sentenceSpans(hunk.before).length, sentenceSpans(hunk.after).length);
  return `${count > 1 ? "Sentences" : "Sentence"} ${sentenceChangeKind(hunk)}`;
}

/**
 * One side of a revised sentence, read in full: the words that differ from
 * the other side are struck (original) or highlighted (revision), so the
 * sentence is compared as a whole rather than word against word.
 */
export function SentenceSide({ hunk, side }: { hunk: Pick<SuggestionHunk, "before" | "after">; side: "before" | "after" }) {
  return <>{diffParts(hunk.before, hunk.after).map((part, index) => {
    if (part.op === "same") return <React.Fragment key={index}>{part.text}</React.Fragment>;
    if (side === "before" && part.op === "remove") return <del key={index}>{part.text}</del>;
    if (side === "after" && part.op === "add") return <ins key={index}>{part.text}</ins>;
    return null;
  })}</>;
}
