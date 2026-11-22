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
import { protectedRewritePreview, type ProtectedSelection } from "../../../shared/ai-text-protection";
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
  | { kind: "atom"; from: number; to: number; preview: string };

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
      pieces.push({ kind: "atom", from: text.length, to: text.length + preview.length, preview });
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

/**
 * Node-local hunks for replacing flat text [from, to), which holds no atom,
 * with `insert`. Inserted words go to the text node they sit in; at a boundary
 * between two formatting runs, to the plainer one.
 */
function gapHunks(view: FlatParagraph, from: number, to: number, insert: string): NodeHunk[] | Refusal {
  const pieces = view.pieces.filter((piece): piece is Extract<Piece, { kind: "text" }> => piece.kind === "text");
  const result: NodeHunk[] = [];
  for (const hunk of diffHunks(view.text.slice(from, to), insert)) {
    const start = from + hunk.from;
    const end = from + hunk.to;
    const touched = pieces.filter((piece) => piece.from < end && piece.to > start);
    for (const piece of touched) {
      result.push({ node: piece.node, from: Math.max(start, piece.from) - piece.from, to: Math.min(end, piece.to) - piece.from, insert: "" });
    }
    if (!hunk.insert) continue;
    let target: Extract<Piece, { kind: "text" }> | undefined;
    if (touched.length) {
      target = touched.find((piece) => start > piece.from || end < piece.to) ?? touched[0];
    } else {
      const inside = pieces.find((piece) => piece.from < start && start < piece.to);
      const left = pieces.find((piece) => piece.to === start);
      const right = pieces.find((piece) => piece.from === start);
      target = inside ?? (left && right ? (right.marks < left.marks ? right : left) : left ?? right);
    }
    if (!target) return { reason: "format", detail: "text between two citations or equations" };
    const at = Math.max(start, target.from) - target.from;
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

/** Literal markup protected inside each text node (`_`, `*`, typed `[@key]`…), in order. */
function literalsByNode(protection: ProtectedSelection) {
  const literals: string[][] = Array.from({ length: protection.textNodeCount }, () => []);
  let node = -1;
  for (const marker of protection.markers) {
    if (marker.kind === "text-open") node = marker.textIndex;
    else if (marker.kind === "text-close") node = -1;
    else if (marker.kind === "literal" && node >= 0) literals[node].push(marker.value);
  }
  return literals;
}

function keepsLiterals(text: string, literals: string[]) {
  let cursor = 0;
  for (const literal of literals) {
    const at = text.indexOf(literal, cursor);
    if (at < 0) return false;
    cursor = at + literal.length;
  }
  return true;
}

/** The block's protected text with each text node replaced; markers and literals stay where they were. */
function protectedResponse(protection: ProtectedSelection, texts: string[]) {
  let output = "";
  let active: { text: string; cursor: number } | null = null;
  for (const marker of protection.markers) {
    if (marker.kind === "text-open") {
      output += marker.token;
      active = { text: texts[marker.textIndex], cursor: 0 };
    } else if (marker.kind === "literal" && active) {
      const at = active.text.indexOf(marker.value, active.cursor);
      output += active.text.slice(active.cursor, at) + marker.token;
      active.cursor = at + marker.value.length;
    } else if (marker.kind === "text-close" && active) {
      output += active.text.slice(active.cursor) + marker.token;
      active = null;
    } else {
      output += marker.token;
    }
  }
  return output;
}

export interface ParagraphPlan {
  /** The rewrite for `applyBlockRewrite`, or null when no change survived. */
  response: string | null;
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
  const plan: ParagraphPlan = { response: null, accepted: [], refused: [], removedCitations: [] };
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

  let texts = view.texts;
  // From the end, so the node offsets of earlier changes stay valid.
  for (const item of [...placed].reverse()) {
    let { from, to, replacement } = item;
    // A quote that cuts through a citation or equation takes all of it.
    for (const piece of view.pieces) {
      if (piece.kind !== "atom") continue;
      if (piece.from < from && from < piece.to) { replacement = view.text.slice(piece.from, from) + replacement; from = piece.from; }
      if (piece.from < to && to < piece.to) { replacement += view.text.slice(to, piece.to); to = piece.to; }
    }
    // Atoms inside the passage must reappear, in order, in the replacement.
    const atoms = view.pieces.filter((piece): piece is Extract<Piece, { kind: "atom" }> => piece.kind === "atom" && piece.from >= from && piece.to <= to && piece.to > piece.from);
    const gaps: Array<{ from: number; to: number; text: string }> = [];
    let cursor = 0;
    let gapStart = from;
    let refusal: Refusal | null = null;
    for (const atom of atoms) {
      const at = replacement.indexOf(atom.preview, cursor);
      if (at < 0) { refusal = { reason: "atom", detail: atom.preview }; break; }
      gaps.push({ from: gapStart, to: atom.from, text: replacement.slice(cursor, at) });
      cursor = at + atom.preview.length;
      gapStart = atom.to;
    }
    gaps.push({ from: gapStart, to, text: replacement.slice(cursor) });
    const hunks: NodeHunk[] = [];
    const removed: RemovedCitation[] = [];
    const why: RemovedCitation["why"] = options.level === "proofread" ? "proofread" : options.citekeys ? "not-in-library" : "no-library";
    for (const gap of refusal ? [] : gaps) {
      const oldText = view.text.slice(gap.from, gap.to);
      const markup = newMarkup(oldText, gap.text);
      if (markup) { refusal = { reason: "markup", detail: markup }; break; }
      // New citations must name a work in references.bib; the Proofread level adds none.
      const kept = new Set(findCitations(oldText).flatMap((span) => span.items.map((cite) => cite.key)));
      const text = rewriteCitations(gap.text, (key) => {
        if (kept.has(key) || (options.level !== "proofread" && options.citekeys?.has(key))) return key;
        removed.push({ key, why });
        return null;
      });
      const gapResult = gapHunks(view, gap.from, gap.to, text);
      if (!Array.isArray(gapResult)) { refusal = gapResult; break; }
      hunks.push(...gapResult);
    }
    if (!refusal) {
      const next = applyNodeHunks(texts, hunks);
      const touched = [...new Set(hunks.map((hunk) => hunk.node))];
      // A formatting run (italic, bold, link…) cannot be emptied, nor protected markup dropped.
      if (touched.some((node) => !next[node].length)) refusal = { reason: "format" };
      else if (touched.some((node) => !keepsLiterals(next[node], literals[node]))) refusal = { reason: "format", detail: "markup" };
      else if (next.every((text, node) => text === texts[node])) refusal = { reason: "unchanged" };
      else {
        texts = next;
        plan.accepted.push(item.index);
        plan.removedCitations.push(...removed);
      }
    }
    if (refusal) {
      plan.refused.push({ index: item.index, ...refusal });
      // "Changes nothing" because its citation was removed: say which and why.
      if (refusal.reason === "unchanged") plan.removedCitations.push(...removed);
    }
  }
  plan.accepted.reverse();
  if (plan.accepted.length) plan.response = protectedResponse(base.protection, texts);
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
    const outcome = applyBlockRewrite(session, base, plan.response, "suggest", AI_ORIGIN, changeSetId, citekeys ?? undefined);
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
