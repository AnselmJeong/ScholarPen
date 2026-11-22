import type { Node as PMNode } from "prosemirror-model";
import {
  MAX_ASSISTANT_CHANGES,
  normalizeParagraphTag,
  type AssistantEditChange,
  type AssistantEditOutcome,
  type AssistantEditRequest,
  type AssistantEditResult,
  type RemovedCitation,
} from "../../../shared/agent-document-edit";
import { protectedRewritePreview, type ProtectedRemovals, type ProtectedSelection } from "../../../shared/ai-text-protection";
import { authorshipBlind } from "../../../shared/collab/ai-authorship";
import { CHANGE_SETS_MAP, type ChangeSetInfo } from "../../../shared/collab/change-sets";
import { SCHOLARPEN_AI } from "../../../shared/collab/personas";
import { recordRevision, REVISIONS_MAP, type RevisionEntry, type RevisionParagraph } from "../../../shared/collab/revision-log";
import { leafText } from "../../../shared/collab/schema-spec";
import { diffHunks } from "../../../shared/collab/text-diff";
import { editLevelExceeded, editLevelGuidance, editLevelLabel, editLevelOf, EDIT_LEVEL_MAX_CHANGE, WRITING_MAP, type EditLevel } from "../../../shared/collab/writing";
import { ZONES_MAP, type Zone } from "../../../shared/collab/zones";
import { glossaryGuidance, type Glossary } from "../../../shared/glossary";
import { mapGuidance, type ManuscriptMap } from "../../../shared/manuscript-map";
import { isLetterDocument } from "../../../shared/review-session/letter-document";
import type { CollabSession } from "../registry";
import { punctuationFromPrompt } from "../../../shared/writing-preferences";
import { changeRate } from "../../../plugins/text-cleanup/main/humanize/humanize";
import type { Attachment, CollabAgent, Job } from "./agent";
import { applyBlockRewrite, captureBlock, nextSuggestionId, type BlockBase } from "./block-edit";
import { findCitations, rewriteCitations } from "./citation-edits";
import { blockContent, findBlock, hasInlineContent, hasSuggestionMarks, listBlocks, readDoc, type BlockRef } from "./doc-model";
import { AI_META_ORIGIN, AI_ORIGIN } from "./origins";
import { clip } from "./prompts";

/**
 * Edits the Assistant tab wrote, applied without a second AI: each change
 * quotes a passage of a paragraph and gives its replacement. Every paragraph
 * goes through ScholarPen AI's own path (`captureBlock` → `applyBlockRewrite`):
 * protected citations and formatting, the section's zone (Observe refuses,
 * anything else lands as a tracked suggestion), the document's edit level and
 * change-rate gate, and no edits over pending suggestions. All of one request
 * is one change set with its label, revision-log entry, undo step origin and
 * Activity job, so it is reviewed exactly like a ScholarPen AI change set.
 */

// ── The paragraph as the Assistant read it ───────────────────────────────────

type Piece =
  | { kind: "text"; node: number; from: number; to: number; marks: number }
  /** `index`: the inline node's place among the paragraph's inline nodes, as its protection marker has it. */
  | { kind: "atom"; index: number; type: string; from: number; to: number; preview: string };
type TextPiece = Extract<Piece, { kind: "text" }>;
type AtomPiece = Extract<Piece, { kind: "atom" }>;

/** A paragraph's text as manuscript-text renders it: text nodes, with atoms (citations, math…) as `[@key]`, `$…$`. */
export interface FlatParagraph {
  text: string;
  pieces: Piece[];
  /** Text of each text node, in order (the same nodes `captureBlock` protects). */
  texts: string[];
}

/** `content` must be the authorship-blind content node, as `captureBlock` reads it. */
export function flatParagraph(content: PMNode): FlatParagraph {
  const pieces: Piece[] = [];
  const texts: string[] = [];
  let text = "";
  let atoms = 0;
  content.descendants((node) => {
    if (node.isText) {
      const value = node.text ?? "";
      pieces.push({ kind: "text", node: texts.length, from: text.length, to: text.length + value.length, marks: node.marks.length });
      texts.push(value);
      text += value;
      return false;
    }
    if (node.isLeaf) {
      const preview = leafText(node);
      pieces.push({ kind: "atom", index: atoms++, type: node.type.name, from: text.length, to: text.length + preview.length, preview });
      text += preview;
      return false;
    }
    return true;
  });
  return { text, pieces, texts };
}

// ── Finding the quoted passage ───────────────────────────────────────────────

const SINGLE_QUOTES = /[‘’‚‛′]/;
const DOUBLE_QUOTES = /[“”„‟″]/;

/** Whitespace runs collapsed and typographic quotes made straight, with each character's original index. */
function normalized(text: string) {
  let out = "";
  const map: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (/\s/.test(char)) {
      if (out.endsWith(" ")) continue;
      out += " ";
    } else {
      out += SINGLE_QUOTES.test(char) ? "'" : DOUBLE_QUOTES.test(char) ? "\"" : char;
    }
    map.push(index);
  }
  return { text: out, map };
}

function occurrences(haystack: string, needle: string) {
  const found: number[] = [];
  for (let at = haystack.indexOf(needle); at >= 0 && needle; at = haystack.indexOf(needle, at + 1)) found.push(at);
  return found;
}

/** What a model may copy before a paragraph's text: its id, a heading or list marker. */
const LEADING_MARKUP = /^\s*(?:\[¶[A-Za-z0-9]+\]\s*)?(?:#{1,6}\s+|[-+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+|>\s*)?/;
const LEADING_TAG = /^\s*\[¶[A-Za-z0-9]+\]\s*/;

type Located = { from: number; to: number; replacement: string } | "not-found" | "ambiguous";

/** Where `change.old` is in the paragraph text: exactly, else ignoring whitespace and quote style. */
export function locateChange(text: string, change: Pick<AssistantEditChange, "old" | "new">): Located {
  const plain = change.old.replace(LEADING_TAG, "");
  const markup = plain.match(LEADING_MARKUP)?.[0] ?? "";
  const candidates = [{ old: plain, replacement: change.new.replace(LEADING_TAG, "") }];
  if (markup.trim()) {
    candidates.push({ old: plain.slice(markup.length), replacement: change.new.replace(LEADING_TAG, "").replace(LEADING_MARKUP, "") });
  }
  let ambiguous = false;
  for (const candidate of candidates) {
    const old = candidate.old.trim();
    if (!old) continue;
    const exact = occurrences(text, old);
    if (exact.length === 1) return withSpacing(text, exact[0], exact[0] + old.length, candidate.replacement);
    if (exact.length > 1) { ambiguous = true; continue; }
    const source = normalized(text);
    const target = normalized(old).text.trim();
    const loose = occurrences(source.text, target);
    if (loose.length === 1) {
      const from = source.map[loose[0]];
      const to = source.map[loose[0] + target.length - 1] + 1;
      return withSpacing(text, from, to, candidate.replacement);
    }
    if (loose.length > 1) ambiguous = true;
  }
  return ambiguous ? "ambiguous" : "not-found";
}

/** A deletion takes one neighbouring space with it, so no double space is left behind. */
function withSpacing(text: string, from: number, to: number, replacement: string) {
  if (replacement.trim()) return { from, to, replacement: replacement.trim() };
  if (text[to] === " " && (from === 0 || /\s/.test(text[from - 1]))) return { from, to: to + 1, replacement: "" };
  if (from > 0 && text[from - 1] === " ") return { from: from - 1, to, replacement: "" };
  return { from, to, replacement: "" };
}

// ── Turning a replacement into the protected rewrite applyBlockRewrite takes ──

type NodeHunk = { node: number; from: number; to: number; insert: string };
type Refusal = { reason: NonNullable<AssistantEditOutcome["reason"]>; detail?: string };

/** Markdown the model may add that would land as literal characters. */
const MARKUP = [
  /\$(?=\S)[^$\n]*\S\$/g,
  /\*\*[^*\n]+\*\*/g,
  /(?<![\w*])\*(?=\S)[^*\n]*\S\*(?![\w*])/g,
  /(?<![\p{L}\p{N}_])_(?=\S)[^_\n]*\S_(?![\p{L}\p{N}_])/gu,
  /(?:^|\n)#{1,6}\s/g,
];

function newMarkup(oldText: string, newText: string) {
  for (const pattern of MARKUP) {
    for (const match of newText.matchAll(pattern)) {
      if (!oldText.includes(match[0])) return match[0].trim();
    }
  }
  return null;
}

/** The text of flat [from, to) without the inline nodes in it, and the flat position of each of its characters. */
function textOf(view: FlatParagraph, from: number, to: number) {
  let text = "";
  const at: number[] = [];
  for (const piece of view.pieces) {
    if (piece.kind !== "text") continue;
    for (let p = Math.max(from, piece.from); p < Math.min(to, piece.to); p++) {
      text += view.text[p];
      at.push(p);
    }
  }
  return { text, at };
}

/**
 * Node-local hunks for replacing the text of flat [from, to) with `insert`.
 * The stretch holds no inline node the change keeps; those it removes are
 * left out of the comparison. Inserted words go to the text node they sit in;
 * at a boundary between two formatting runs, to the plainer one.
 */
function gapHunks(view: FlatParagraph, from: number, to: number, insert: string): NodeHunk[] | Refusal {
  const pieces = view.pieces.filter((piece): piece is TextPiece => piece.kind === "text");
  const old = textOf(view, from, to);
  const result: NodeHunk[] = [];
  for (const hunk of diffHunks(old.text, insert)) {
    // Right after the text before the hunk, and at the hunk's first character: only removed inline nodes lie between.
    const before = hunk.from > 0 ? old.at[hunk.from - 1] + 1 : from;
    const start = hunk.from < old.at.length ? old.at[hunk.from] : to;
    const end = hunk.to > hunk.from ? old.at[hunk.to - 1] + 1 : start;
    const touched = hunk.to > hunk.from ? pieces.filter((piece) => piece.from < end && piece.to > start) : [];
    for (const piece of touched) {
      result.push({ node: piece.node, from: Math.max(start, piece.from) - piece.from, to: Math.min(end, piece.to) - piece.from, insert: "" });
    }
    if (!hunk.insert) continue;
    let target: TextPiece | undefined;
    let at = 0;
    if (touched.length) {
      target = touched.find((piece) => start > piece.from || end < piece.to) ?? touched[0];
      at = Math.max(start, target.from) - target.from;
    } else {
      const inside = before === start ? pieces.find((piece) => piece.from < start && start < piece.to) : undefined;
      const left = pieces.find((piece) => piece.to === before);
      const right = pieces.find((piece) => piece.from === start);
      target = inside ?? (left && right ? (right.marks < left.marks ? right : left) : left ?? right);
      if (target) at = (target === left ? before : start) - target.from;
    }
    if (!target) return { reason: "format", detail: "text between two citations or equations" };
    const existing = result.find((item) => item.node === target!.node && item.from === at && item.insert === "");
    if (existing) existing.insert = hunk.insert;
    else result.push({ node: target.node, from: at, to: at, insert: hunk.insert });
  }
  return result;
}

function applyNodeHunks(texts: string[], hunks: NodeHunk[]) {
  const next = [...texts];
  for (const hunk of [...hunks].sort((a, b) => b.node - a.node || b.from - a.from || b.to - a.to)) {
    next[hunk.node] = next[hunk.node].slice(0, hunk.from) + hunk.insert + next[hunk.node].slice(hunk.to);
  }
  return next;
}

type Literal = { token: string; from: number; to: number };

/** Literal markup protected inside each text node (`_`, `*`, URLs, typed `[@key]`…), with its place in the node's text. */
function literalsByNode(protection: ProtectedSelection) {
  const literals: Literal[][] = Array.from({ length: protection.textNodeCount }, () => []);
  let node = -1;
  let offset = 0;
  let cursor = 0;
  for (const marker of protection.markers) {
    const at = protection.protectedText.indexOf(marker.token, cursor);
    if (node >= 0) offset += at - cursor;
    if (marker.kind === "text-open") {
      node = marker.textIndex;
      offset = 0;
    } else if (marker.kind === "text-close") {
      node = -1;
    } else if (marker.kind === "literal" && node >= 0) {
      literals[node].push({ token: marker.token, from: offset, to: offset + marker.value.length });
      offset += marker.value.length;
    }
    cursor = at + marker.token.length;
  }
  return literals;
}

/** Literal markup a change removes whole (its tokens), or null when it would change one only in part. */
function removedLiterals(literals: Literal[][], hunks: NodeHunk[]): string[] | null {
  const removed: string[] = [];
  for (const node of new Set(hunks.map((hunk) => hunk.node))) {
    const own = hunks.filter((hunk) => hunk.node === node);
    for (const literal of literals[node]) {
      if (own.some((hunk) => hunk.to > hunk.from && hunk.from <= literal.from && literal.to <= hunk.to)) removed.push(literal.token);
      else if (own.some((hunk) => hunk.from < literal.to && (hunk.to > literal.from || (hunk.to === hunk.from && hunk.from > literal.from)))) return null;
    }
  }
  return removed;
}

/**
 * The block's protected text with each text node rewritten by `hunks`; markers
 * stay where they were, except those of the inline nodes and literal markup
 * in `removed`.
 */
function protectedResponse(protection: ProtectedSelection, texts: string[], hunks: NodeHunk[], literals: Literal[][], removed: ReadonlySet<string>) {
  const next = applyNodeHunks(texts, hunks);
  // Where a kept literal lands: every hunk before it (or inserting right at it) moves it.
  const moved = (node: number, at: number) => at + hunks
    .filter((hunk) => hunk.node === node && hunk.to <= at)
    .reduce((delta, hunk) => delta + hunk.insert.length - (hunk.to - hunk.from), 0);
  let output = "";
  for (const marker of protection.markers) {
    if (removed.has(marker.token) || marker.kind === "literal") continue;
    output += marker.token;
    if (marker.kind !== "text-open") continue;
    const text = next[marker.textIndex];
    let cursor = 0;
    for (const literal of literals[marker.textIndex]) {
      if (removed.has(literal.token)) continue;
      const at = moved(marker.textIndex, literal.from);
      output += text.slice(cursor, at) + literal.token;
      cursor = at + literal.to - literal.from;
    }
    output += text.slice(cursor);
  }
  return output;
}

/**
 * How a model writes a cross-reference or footnote it means to keep in altered
 * form. Plain text would not become the node again, so that is refused; an
 * altered citation comes back as a citation node and an altered equation is
 * refused as Markdown.
 */
const ALTERED_ATOM: Record<string, RegExp> = {
  crossReference: /(?<![\w@])@[A-Za-z][\w:.-]*/g,
  footnote: /\[\^[^\]\s]+\]/g,
};

type ChangePlan = {
  hunks: NodeHunk[];
  /** Inline nodes the change removes: in the quote, whole, and left out of the replacement. */
  atoms: AtomPiece[];
  removedCitations: RemovedCitation[];
  /** Keys of the citations it removes; typed again elsewhere in the change, they come back as citation nodes. */
  movedCitekeys: string[];
};

/**
 * One located change as node hunks. Inline nodes inside the quoted passage
 * that the replacement still shows (its `[@key]`, `$…$`) stay, in order; one
 * it leaves out is removed with the passage, so deleting a sentence takes its
 * citation, equation or italic variable with it. Only what the quote holds
 * whole can go: a citation the quote cuts through, or a line break in a
 * passage that is reworded rather than deleted, refuses the change.
 */
function planChange(
  view: FlatParagraph,
  located: { from: number; to: number; replacement: string },
  options: { citekeys: ReadonlySet<string> | null; level: EditLevel },
): ChangePlan | (Refusal & { removedCitations: RemovedCitation[] }) {
  let { from, to, replacement } = located;
  // A quote that cuts through a citation or equation takes all of it, though it may not remove it.
  for (const piece of view.pieces) {
    if (piece.kind !== "atom") continue;
    if (piece.from < from && from < piece.to) { replacement = view.text.slice(piece.from, from) + replacement; from = piece.from; }
    if (piece.from < to && to < piece.to) { replacement += view.text.slice(to, piece.to); to = piece.to; }
  }
  const atoms = view.pieces.filter((piece): piece is AtomPiece => piece.kind === "atom" && piece.from >= from && piece.to <= to && piece.to > piece.from);
  const kept: Array<{ atom: AtomPiece; at: number }> = [];
  const dropped: AtomPiece[] = [];
  let cursor = 0;
  for (const atom of atoms) {
    const at = replacement.indexOf(atom.preview, cursor);
    if (at >= 0) {
      kept.push({ atom, at });
      cursor = at + atom.preview.length;
      continue;
    }
    const quoted = atom.from >= located.from && atom.to <= located.to;
    // Models drop line breaks when they rewrap text: one goes only with a passage deleted outright.
    if (!quoted || (!atom.preview.trim() && replacement.trim())) return { reason: "atom", detail: atom.preview, removedCitations: [] };
    dropped.push(atom);
  }
  // The replacement's own words: without the nodes it keeps and without citation groups.
  let words = replacement;
  for (const { atom, at } of [...kept].reverse()) words = words.slice(0, at) + " " + words.slice(at + atom.preview.length);
  words = words.replace(/\[@[^\]\n]*\]/g, " ");
  const passageText = textOf(view, from, to).text;
  const altered = dropped.find((atom) => {
    const syntax = ALTERED_ATOM[atom.type];
    return !!syntax && [...words.matchAll(syntax)].some((match) => !passageText.includes(match[0]));
  });
  if (altered) return { reason: "atom", detail: altered.preview, removedCitations: [] };
  const gaps: Array<{ from: number; to: number; text: string }> = [];
  let gapStart = from;
  let textStart = 0;
  for (const { atom, at } of kept) {
    gaps.push({ from: gapStart, to: atom.from, text: replacement.slice(textStart, at) });
    textStart = at + atom.preview.length;
    gapStart = atom.to;
  }
  gaps.push({ from: gapStart, to, text: replacement.slice(textStart) });

  const movedCitekeys = findCitations(dropped.map((atom) => atom.preview).join(" ")).flatMap((span) => span.items.map((cite) => cite.key));
  const hunks: NodeHunk[] = [];
  const removedCitations: RemovedCitation[] = [];
  const why: RemovedCitation["why"] = options.level === "proofread" ? "proofread" : options.citekeys ? "not-in-library" : "no-library";
  for (const gap of gaps) {
    const oldText = textOf(view, gap.from, gap.to).text;
    const markup = newMarkup(oldText, gap.text);
    if (markup) return { reason: "markup", detail: markup, removedCitations: [] };
    // New citations must name a work in references.bib; the Proofread level adds none. The passage's own may move.
    const own = new Set([...findCitations(oldText).flatMap((span) => span.items.map((cite) => cite.key)), ...movedCitekeys]);
    const text = rewriteCitations(gap.text, (key) => {
      if (own.has(key) || (options.level !== "proofread" && options.citekeys?.has(key))) return key;
      removedCitations.push({ key, why });
      return null;
    });
    const result = gapHunks(view, gap.from, gap.to, text);
    if (!Array.isArray(result)) return { ...result, removedCitations: [] };
    hunks.push(...result);
  }
  return { hunks, atoms: dropped, removedCitations, movedCitekeys };
}

export interface ParagraphPlan {
  /** The rewrite for `applyBlockRewrite`, or null when no change survived. */
  response: string | null;
  /** What the rewrite removes (formatting runs, inline nodes, literal markup), all inside quoted passages. */
  removals: ProtectedRemovals | null;
  /** Keys of removed citations that a change typed again: they become citation nodes even if references.bib lacks them. */
  movedCitekeys: string[];
  /** Indexes (into the request) of the changes the response carries. */
  accepted: number[];
  refused: Array<{ index: number } & Refusal>;
  removedCitations: RemovedCitation[];
}

/**
 * Plans one paragraph's changes against its live text. Each change is checked
 * on its own: a change that cannot be placed safely is refused and the others
 * still apply.
 */
export function planParagraph(
  base: BlockBase,
  content: PMNode,
  changes: Array<{ index: number; change: AssistantEditChange }>,
  options: { citekeys: ReadonlySet<string> | null; level: EditLevel },
): ParagraphPlan {
  const view = flatParagraph(content);
  const literals = literalsByNode(base.protection);
  const nodeTokens = base.protection.markers.filter((marker) => marker.kind === "node").map((marker) => marker.token);
  const plan: ParagraphPlan = { response: null, removals: null, movedCitekeys: [], accepted: [], refused: [], removedCitations: [] };
  const located: Array<{ index: number; from: number; to: number; replacement: string }> = [];
  for (const { index, change } of changes) {
    const place = locateChange(view.text, change);
    if (place === "not-found" || place === "ambiguous") plan.refused.push({ index, reason: place });
    else located.push({ index, ...place });
  }
  located.sort((a, b) => a.from - b.from);
  const placed: typeof located = [];
  for (const item of located) {
    const previous = placed.at(-1);
    if (previous && item.from < previous.to) plan.refused.push({ index: item.index, reason: "overlap" });
    else placed.push(item);
  }

  // Changes do not overlap, so every hunk is in the paragraph's original coordinates.
  const hunks: NodeHunk[] = [];
  const removed = new Set<string>();
  for (const item of placed) {
    const change = planChange(view, item, options);
    if (!("hunks" in change)) {
      plan.refused.push({ index: item.index, reason: change.reason, ...(change.detail ? { detail: change.detail } : {}) });
      continue;
    }
    if (!change.hunks.length && !change.atoms.length) {
      // "Changes nothing" because its citation was removed: say which and why.
      plan.refused.push({ index: item.index, reason: "unchanged" });
      plan.removedCitations.push(...change.removedCitations);
      continue;
    }
    // Literal markup (code, URLs, `_`, `*`) goes only whole, with the quoted passage.
    const literalsRemoved = removedLiterals(literals, change.hunks);
    if (!literalsRemoved) {
      plan.refused.push({ index: item.index, reason: "format", detail: "markup" });
      continue;
    }
    hunks.push(...change.hunks);
    for (const token of [...literalsRemoved, ...change.atoms.map((atom) => nodeTokens[atom.index])]) removed.add(token);
    plan.accepted.push(item.index);
    plan.removedCitations.push(...change.removedCitations);
    plan.movedCitekeys.push(...change.movedCitekeys);
  }
  if (plan.accepted.length) {
    const next = applyNodeHunks(view.texts, hunks);
    plan.response = protectedResponse(base.protection, view.texts, hunks, literals, removed);
    // A formatting run the changes empty is removed whole, like the inline nodes and literals they leave out.
    plan.removals = { texts: next.flatMap((text, node) => text ? [] : [node]), markers: [...removed] };
  }
  return plan;
}

// ── The rules the Assistant writes under ─────────────────────────────────────

/** Headings of the sections set to Observe, where AI edits are refused. */
export function observedSections(session: CollabSession): string[] {
  const doc = readDoc(session);
  const names: string[] = [];
  for (const [headingId, zone] of session.ydoc.getMap<Zone>(ZONES_MAP).entries()) {
    if (zone?.trust !== "observe") continue;
    const block = findBlock(doc, headingId);
    const name = block ? blockContent(block).node.textContent.trim() : "";
    if (name) names.push(name);
  }
  return names;
}

/**
 * The open document's standing rules for the Assistant's system prompt: the
 * same edit level, glossary and chapter map ScholarPen AI follows, plus the
 * sections where edits are refused.
 */
export function assistantEditRules(session: CollabSession, guide: { glossary: Glossary; map: ManuscriptMap } | null) {
  if (isLetterDocument(session.filename)) return "The active document is a response letter. You cannot edit it.";
  const level = editLevelOf(session.ydoc.getMap(WRITING_MAP));
  const observed = observedSections(session);
  return [
    `Edit level of the active document: ${editLevelLabel(level)} (one edit may change at most ${Math.round(EDIT_LEVEL_MAX_CHANGE[level] * 100)}% of a paragraph).`,
    editLevelGuidance(level),
    observed.length ? `Sections set to Observe, where every edit is refused: ${observed.join("; ")}.` : "",
    guide ? glossaryGuidance(guide.glossary) : "",
    guide ? mapGuidance(guide.map, session.filename, 4_000) : "",
  ].filter(Boolean).join("\n\n");
}

// ── Running it as an agent job ───────────────────────────────────────────────

export interface AssistantEditDeps {
  /** Citekeys of the project's references.bib; null when it cannot be read. */
  citekeys(projectPath: string): Promise<ReadonlySet<string> | null>;
  now?: () => number;
  /** How long the request may wait in the agent's queue before the chat stops waiting. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 9 * 60_000;

/** The block a change names: by its paragraph id, else the one prose block holding the quoted text. */
function resolveBlock(prose: BlockRef[], change: AssistantEditChange): BlockRef | null {
  const tag = normalizeParagraphTag(change.paragraph);
  const tagged = tag ? prose.filter((block) => block.id.replace(/[^A-Za-z0-9]/g, "").startsWith(tag)) : [];
  if (tagged.length === 1) {
    const place = locateChange(flatParagraph(authorshipBlind(blockContent(tagged[0]).node)).text, change);
    if (place !== "not-found") return tagged[0];
  }
  const holding = prose.filter((block) => locateChange(flatParagraph(authorshipBlind(blockContent(block).node)).text, change) !== "not-found");
  return holding.length === 1 ? holding[0] : tagged.length === 1 ? tagged[0] : null;
}

function isProse(block: BlockRef) {
  const content = blockContent(block).node;
  return hasInlineContent(block) && content.type.name !== "codeBlock" && !content.type.spec.code;
}

/**
 * Applies the Assistant's edit to an open document and resolves with what
 * landed and what was refused. The work runs as one job in ScholarPen AI's
 * queue (Activity entry, history checkpoints, undo origin `ai-agent`).
 */
export async function runAssistantEdit(agent: CollabAgent, request: AssistantEditRequest, deps: AssistantEditDeps): Promise<AssistantEditResult> {
  const refused = (reason: NonNullable<AssistantEditResult["reason"]>): AssistantEditResult => ({ status: "refused", reason, outcomes: [], removedCitations: [] });
  const attachment = agent.attachmentFor(request.docKey);
  if (!attachment) return refused("not-open");
  if (isLetterDocument(attachment.session.filename)) return refused("letter");
  // Indexes stay those of the request: the chat matches outcomes to the changes it showed.
  const changes = request.changes.slice(0, MAX_ASSISTANT_CHANGES);
  if (!changes.some((change) => change.old.trim())) return refused("empty");
  if (agent.isPaused()) return refused("paused");
  const citekeys = await deps.citekeys(attachment.session.projectPath).catch(() => null);
  const label = `Assistant: ${clip(request.request.replace(/\s+/g, " ").trim() || request.summary || "edit", 80, "start").replace(/\n\[…\]$/, "…")}`;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AssistantEditResult>((resolve) => {
    timer = setTimeout(() => resolve(refused("timeout")), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  });
  const job = new Promise<AssistantEditResult>((resolve) => {
    agent.enqueue(attachment, { kind: "assistant", label, agent: SCHOLARPEN_AI.id }, async (job, att, signal) => {
      try {
        resolve(await applyAssistantEdit(agent, job, att, { ...request, changes }, label, citekeys, signal, deps.now ?? Date.now));
      } catch (error) {
        resolve({ status: "failed", error: error instanceof Error ? error.message : String(error), outcomes: [], removedCitations: [] });
        throw error;
      }
    });
  });
  try {
    return await Promise.race([job, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function applyAssistantEdit(
  agent: CollabAgent,
  job: Job,
  attachment: Attachment,
  request: AssistantEditRequest,
  label: string,
  citekeys: ReadonlySet<string> | null,
  signal: AbortSignal,
  now: () => number,
): Promise<AssistantEditResult> {
  const { session } = attachment;
  const level = editLevelOf(session.ydoc.getMap(WRITING_MAP));
  job.level = level;
  job.policy = await agent.policyFor(session, level);
  signal.throwIfAborted();
  const punctuation = punctuationFromPrompt(job.policy);

  const outcomes = new Map<number, AssistantEditOutcome>();
  const refuse = (index: number, reason: NonNullable<AssistantEditOutcome["reason"]>, detail?: string, blockId?: string) =>
    outcomes.set(index, { index, applied: false, reason, ...(detail ? { detail } : {}), ...(blockId ? { blockId } : {}) });

  // Group the changes by paragraph, in document order.
  const doc = readDoc(session);
  const prose = listBlocks(doc).filter(isProse);
  const groups = new Map<string, Array<{ index: number; change: AssistantEditChange }>>();
  request.changes.forEach((change, index) => {
    const block = resolveBlock(prose, change);
    if (!block) {
      const tagged = listBlocks(doc).find((item) => change.paragraph && item.id.replace(/[^A-Za-z0-9]/g, "").startsWith(normalizeParagraphTag(change.paragraph)));
      refuse(index, tagged && !isProse(tagged) ? "not-prose" : "not-found");
      return;
    }
    groups.set(block.id, [...(groups.get(block.id) ?? []), { index, change }]);
  });
  const order = prose.map((block) => block.id).filter((id) => groups.has(id));

  const changeSetId = nextSuggestionId(doc);
  const paragraphs: RevisionParagraph[] = [];
  const removedCitations: RemovedCitation[] = [];
  let applied = 0;
  for (const blockId of order) {
    const group = groups.get(blockId)!;
    await agent.waitForAuthor(job, attachment, [blockId], signal);
    signal.throwIfAborted();
    agent.reportProgress(job, `Applying ${request.changes.length} change${request.changes.length === 1 ? "" : "s"} · ${applied} applied`);
    // Read the paragraph now, after waiting: this is the base the stale check compares against.
    const block = findBlock(readDoc(session), blockId);
    if (!block || !isProse(block)) {
      for (const { index } of group) refuse(index, "not-found", undefined, blockId);
      continue;
    }
    if (agent.modeFor(attachment, blockId) === "observe") {
      for (const { index } of group) refuse(index, "observe", undefined, blockId);
      continue;
    }
    if (hasSuggestionMarks(blockContent(block).node)) {
      for (const { index } of group) refuse(index, "pending", undefined, blockId);
      continue;
    }
    const base = captureBlock(block, punctuation);
    const plan = planParagraph(base, authorshipBlind(blockContent(block).node), group, { citekeys, level });
    for (const item of plan.refused) refuse(item.index, item.reason, item.detail, blockId);
    removedCitations.push(...plan.removedCitations);
    if (!plan.response) continue;

    const before = protectedRewritePreview(base.protection.protectedText, base.protection);
    const after = protectedRewritePreview(plan.response, base.protection);
    const rate = changeRate(before, after);
    if (editLevelExceeded(level, rate)) {
      const detail = `${Math.round(rate * 100)}% > ${Math.round(EDIT_LEVEL_MAX_CHANGE[level] * 100)}% (${editLevelLabel(level)})`;
      for (const index of plan.accepted) refuse(index, "level", detail, blockId);
      continue;
    }
    attachment.presence.claim(blockId, "editing");
    // Observe was refused above, so every edit lands as a tracked suggestion.
    // A removed citation typed again elsewhere in its change comes back as a citation node.
    const known = plan.movedCitekeys.length ? new Set([...(citekeys ?? []), ...plan.movedCitekeys]) : citekeys ?? undefined;
    const outcome = applyBlockRewrite(session, base, plan.response, "suggest", AI_ORIGIN, changeSetId, known, plan.removals ?? undefined);
    attachment.presence.release();
    if (outcome.kind === "applied") {
      for (const index of plan.accepted) outcomes.set(index, { index, applied: true, blockId });
      applied += plan.accepted.length;
      paragraphs.push({ blockId, before, after });
    } else if (outcome.kind === "unchanged") {
      for (const index of plan.accepted) refuse(index, "unchanged", undefined, blockId);
    } else {
      for (const index of plan.accepted) refuse(index, "conflict", outcome.reason, blockId);
    }
  }

  let revisionId: string | undefined;
  if (paragraphs.length) {
    session.ydoc.transact(() => {
      session.ydoc.getMap<ChangeSetInfo>(CHANGE_SETS_MAP).set(String(changeSetId), {
        id: changeSetId, label, persona: SCHOLARPEN_AI.id, createdAt: now(),
      });
      revisionId = recordRevision(session.ydoc.getMap<RevisionEntry>(REVISIONS_MAP), {
        createdAt: now(), kind: "assistant", label, changeSetId, status: "pending", level,
        summary: request.summary.trim() || label, items: [], paragraphs,
      });
    }, AI_META_ORIGIN);
  }
  const list = request.changes.map((_, index) => outcomes.get(index) ?? { index, applied: false, reason: "not-found" as const });
  agent.reportProgress(job, `${applied} of ${request.changes.length} change${request.changes.length === 1 ? "" : "s"} applied`);
  return {
    status: paragraphs.length ? "applied" : "refused",
    outcomes: list,
    removedCitations: removedCitations.filter((item, index) => removedCitations.findIndex((other) => other.key === item.key) === index),
    ...(paragraphs.length ? { changeSetId, revisionId } : {}),
  };
}
