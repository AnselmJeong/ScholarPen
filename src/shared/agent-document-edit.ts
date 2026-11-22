import { isLetterDocument } from "./review-session/letter-document";

/**
 * The Assistant tab edits manuscripts itself. Asked to change a document, the
 * model answers with one `<scholarpen_edit>` block per document: for each
 * place, the exact current text of a paragraph (`old`) and its replacement
 * (`new`). ScholarPen applies the block through ScholarPen AI's edit path in
 * Bun (zones, edit level, pending-suggestion check, tracked changes) and
 * reports in the chat what was applied and what was refused.
 */

/** One replacement inside one paragraph. */
export interface AssistantEditChange {
  /** Paragraph id as the model saw it (`[¶3f2a9c1e]` → `3f2a9c1e`); may be empty. */
  paragraph: string;
  /** Exact current text of the passage, copied from the paragraph. */
  old: string;
  /** Replacement; empty deletes `old`. */
  new: string;
}

/** Everything one answer asks to change in one document. */
export interface AssistantDocumentEdit {
  /** Path as the model wrote it: project-relative (`documents/x.scholarpen.json`), absolute, or empty for the open document. */
  document: string;
  summary: string;
  changes: AssistantEditChange[];
  /** Changes left out because they were malformed (no `<old>`, or nothing to find). */
  malformed: number;
}

/** What the renderer sends to Bun for one document. */
export interface AssistantEditRequest {
  docKey: string;
  /** The author's chat message that asked for the edit (the change set's label). */
  request: string;
  summary: string;
  changes: AssistantEditChange[];
}

/** Why one change was not applied. */
export type AssistantEditRefusal =
  | "observe"      // the section's zone is Observe
  | "pending"      // the paragraph already has pending suggested changes
  | "not-found"    // the quoted text is not in the document (any more)
  | "ambiguous"    // the quoted text occurs more than once
  | "overlap"      // it overlaps another change in the same paragraph
  | "level"        // the paragraph would change more than the edit level allows
  | "atom"         // it would remove or alter a citation, equation, cross-reference or footnote
  | "format"       // it would delete a whole formatted run (italic, bold, link…) or protected markup
  | "markup"       // the new text has Markdown that would appear as literal characters
  | "not-prose"    // the target is code, a table or a figure
  | "unchanged"    // the replacement equals the original
  | "conflict";    // applying it failed the stale check; `detail` says why

export interface AssistantEditOutcome {
  /** Index into the request's changes. */
  index: number;
  applied: boolean;
  reason?: AssistantEditRefusal;
  /** Extra words for the reason: the citation that would be removed, the change rate, the stale-check message. */
  detail?: string;
  /** Block the change landed in (or was meant for). */
  blockId?: string;
}

/** A new `[@key]` the edit could not keep: unknown to references.bib, or added at the Proofread level. */
export interface RemovedCitation {
  key: string;
  why: "not-in-library" | "no-library" | "proofread";
}

export interface AssistantEditResult {
  /**
   * "applied": at least one change landed as a tracked change; "refused": none
   * did, and `outcomes` (or `reason` for the whole request) say why; "failed":
   * the job stopped with `error`.
   */
  status: "applied" | "refused" | "failed";
  /** Refusal of the whole request. */
  reason?: "not-open" | "letter" | "paused" | "empty" | "timeout";
  error?: string;
  outcomes: AssistantEditOutcome[];
  /** New citations taken out of the replacement text before it was applied. */
  removedCitations: RemovedCitation[];
  changeSetId?: number;
  /** Revision-log entry that records the change set and, later, the author's decision. */
  revisionId?: string;
}

const COMPLETE_BLOCK = /<scholarpen_edit\b([^>]*)>([\s\S]*?)<\/scholarpen_edit>/g;
const CHANGE = /<change\b([^>]*)>([\s\S]*?)<\/change>/g;
const OPEN_TAG = "<scholarpen_edit";

const MAX_DOCUMENTS = 3;
/** ScholarPen AI edits at most 60 paragraphs per request; one answer gets the same budget. */
export const MAX_ASSISTANT_CHANGES = 60;
const MAX_TEXT = 8_000;

function attribute(attributes: string, name: string): string {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

/** The text of `<tag>…</tag>` (or null), without the line breaks models put around it. */
function element(body: string, tag: string): string | null {
  if (new RegExp(`<${tag}\\s*/>`).test(body)) return "";
  const match = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!match) return null;
  return match[1].replace(/^[ \t]*\r?\n/, "").replace(/\r?\n[ \t]*$/, "").slice(0, MAX_TEXT);
}

/** Paragraph id as written: `[¶3f2a9c1e]`, `¶3f2a9c1e` or `3f2a9c1e`. */
export function normalizeParagraphTag(tag: string) {
  return tag.replace(/[^A-Za-z0-9]/g, "");
}

/** Complete edit blocks in a finished answer, at most three documents and sixty changes. */
export function extractDocumentEdits(text: string): AssistantDocumentEdit[] {
  const edits: AssistantDocumentEdit[] = [];
  let budget = MAX_ASSISTANT_CHANGES;
  for (const match of text.matchAll(COMPLETE_BLOCK)) {
    const changes: AssistantEditChange[] = [];
    let malformed = 0;
    for (const change of match[2].matchAll(CHANGE)) {
      // Models sometimes list untouched paragraphs as empty changes: nothing to apply or report.
      if (!change[2].trim()) continue;
      const old = element(change[2], "old");
      const replacement = element(change[2], "new");
      if (!old?.trim() || replacement === null || budget <= 0) {
        malformed++;
        continue;
      }
      changes.push({ paragraph: normalizeParagraphTag(attribute(change[1], "paragraph")), old, new: replacement });
      budget--;
    }
    if (!changes.length && !malformed) continue;
    edits.push({ document: attribute(match[1], "document"), summary: attribute(match[1], "summary"), changes, malformed });
    if (edits.length >= MAX_DOCUMENTS) break;
  }
  return edits;
}

/** Short name of a manuscript path for messages: the file name without `.scholarpen.json`. */
export function documentEditLabel(path: string): string {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return name.replace(/\.scholarpen\.json$/i, "") || path;
}

/** Text from the start of a block whose closing tag has not arrived (or of its tag name), or -1. */
function unfinishedEditStart(text: string): number {
  const open = text.lastIndexOf(OPEN_TAG);
  if (open >= 0 && !text.includes("</scholarpen_edit>", open)) return open;
  const last = text.lastIndexOf("<");
  return last >= 0 && last > text.length - OPEN_TAG.length && OPEN_TAG.startsWith(text.slice(last)) ? last : -1;
}

/** True when the answer opened an edit block it never closed (so nothing was applied). */
export function hasUnfinishedDocumentEdit(text: string): boolean {
  const open = text.lastIndexOf(OPEN_TAG);
  return open >= 0 && !text.includes("</scholarpen_edit>", open);
}

const PREVIEW = 280;

function clipText(text: string, limit = PREVIEW) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Literal Markdown in quoted manuscript text would render as formatting in the chat. */
function escapeMarkdown(text: string) {
  return text.replace(/[\\`*_~[\]$<>|#]/g, "\\$&");
}

/**
 * What the chat shows: each edit block as a quote of what will change. While
 * streaming, a block still being written is hidden until it is complete.
 */
export function formatDocumentEdits(text: string, lang: "ko" | "en", streaming = true): string {
  const ko = lang === "ko";
  const shown = text.replace(COMPLETE_BLOCK, (whole: string) => {
    const [edit] = extractDocumentEdits(whole);
    if (!edit) return "";
    const target = edit.document ? documentEditLabel(edit.document) : ko ? "현재 문서" : "current document";
    const lines = [`> **${ko ? "문서 수정" : "Document edit"} · ${escapeMarkdown(target)}**${edit.summary ? ` — ${escapeMarkdown(clipText(edit.summary))}` : ""}`, ">"];
    for (const change of edit.changes) {
      const replacement = change.new.trim()
        ? `→ ${escapeMarkdown(clipText(change.new))}`
        : ko ? "→ (삭제)" : "→ (deleted)";
      lines.push(`> - ~~${escapeMarkdown(clipText(change.old))}~~`, `>   ${replacement}`);
    }
    if (edit.malformed) lines.push(`> - ${ko ? `형식이 잘못된 수정 ${edit.malformed}개는 적용하지 않습니다.` : `${edit.malformed} malformed change(s) will not be applied.`}`);
    return lines.join("\n");
  });
  if (!streaming) return shown;
  const cut = unfinishedEditStart(shown);
  return cut < 0 ? shown : shown.slice(0, cut).trimEnd();
}

export type DocumentEditTarget =
  | { ok: true; path: string; filename: string }
  | { ok: false; reason: "invalid-target" | "letter" };

/**
 * The manuscript a block targets. Only `documents/**\/*.scholarpen.json` of
 * this project qualifies, never a response letter. An empty name means the
 * open document.
 */
export function resolveDocumentEditTarget(
  document: string,
  projectPath: string,
  activeDocumentPath?: string | null,
): DocumentEditTarget {
  const root = projectPath.replace(/[\\/]+$/, "");
  const requested = document.trim().replace(/^@\[(.*)\]$/, "$1").replace(/^@/, "");
  const raw = requested || activeDocumentPath || "";
  if (!raw) return { ok: false, reason: "invalid-target" };
  const absolute = raw.startsWith("/") ? raw : `${root}/${raw.replace(/^\.\//, "")}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return { ok: false, reason: "invalid-target" };
    parts.push(part);
  }
  const normalized = `/${parts.join("/")}`;
  const documents = `${root}/documents/`;
  if (!normalized.startsWith(documents) || !/\.scholarpen\.json$/i.test(normalized)) return { ok: false, reason: "invalid-target" };
  const filename = normalized.slice(documents.length);
  if (isLetterDocument(filename)) return { ok: false, reason: "letter" };
  return { ok: true, path: normalized, filename };
}

/** `[¶3f2a9c1e] ` before a paragraph in the Assistant's view of a document. */
export const PARAGRAPH_TAG = /^([ \t]*)\[¶([A-Za-z0-9]+)\] /gm;

/** The manuscript text without paragraph ids, for requests that cannot edit. */
export function stripParagraphTags(text: string) {
  return text.replace(PARAGRAPH_TAG, "$1");
}

/** Instructions for the Assistant's system message (general chat in a project only). */
export const DOCUMENT_EDIT_PROTOCOL = [
  "You can edit the manuscript documents of this project. ScholarPen applies your edit to the document as tracked changes that the author keeps or reverts, under the document's AI edit level and section settings, and reports in the chat what was applied and what was refused.",
  "Edit only when the user's latest message asks you to change, rewrite, delete, shorten, correct or otherwise edit a manuscript document (including a request to retry such an edit). Never edit for questions, explanations or suggestions the user has not asked to apply; offer those in prose.",
  "Each paragraph and heading of a supplied document starts with its id, like [¶3f2a9c1e]. The id is not part of the text.",
  "To edit, write a brief reply saying what you are changing (it is not applied yet, so never say it is done), then one block per document:",
  '<scholarpen_edit document="documents/<file>.scholarpen.json" summary="One sentence on what the edit does">',
  '<change paragraph="3f2a9c1e">',
  "<old>exact current text to replace, copied character for character from that paragraph</old>",
  "<new>its replacement</new>",
  "</change>",
  "</scholarpen_edit>",
  "Rules:",
  "- old is the smallest span that holds the whole change (a phrase, a sentence or the whole paragraph), copied exactly from the paragraph and occurring only once in it. Write one <change> per separate place; several may target one paragraph, and they must not overlap.",
  "- new is plain text in the paragraph's language. Leave <new></new> empty to delete old.",
  "- Keep every citation [@key], cross-reference @label, footnote [^n] and equation $…$ that lies inside old exactly as written in new: they can be moved within the change but not removed or altered. Add a citation as [@key] only with a key from the project's references.bib.",
  "- No Markdown in new: no *, **, _, # or new $…$; they would appear as literal characters.",
  "- A change stays inside its paragraph. You cannot add, delete, split, merge or move whole paragraphs, headings, tables, figures or equations; say so instead.",
  "- document is the project-relative path of the active document or of a document the user mentioned; leave it empty for the active document. Only documents under documents/ can be edited, never response letters.",
  "- The document's edit level limits how much of a paragraph one edit may change: Proofread (corrections only, at most 25% of a paragraph, no new citations), Sentence (at most 60%), Structural (any). Larger edits are refused.",
  "Writing the block is not a tool call and touches no file by itself.",
].join("\n");
