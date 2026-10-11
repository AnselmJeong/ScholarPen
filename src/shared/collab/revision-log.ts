import type * as Y from "yjs";
import type { EditLevel } from "./writing";

/**
 * A durable record of every revision ScholarPen AI made or proposed in a
 * document: which comments it answered, why, what text changed and which
 * references it added. Lives in the shared Y.Doc next to the comments.
 */
export const REVISIONS_MAP = "revisions";

export type RevisionStatus = "pending" | "accepted" | "rejected" | "partial" | "applied";

export interface RevisionItem {
  threadId: string;
  /** The comment that asked for the change (reviewer, AI review or the author). */
  comment: string;
  commentBy: "ai" | "author";
  /** The AI's explanation, or its question when the comment needs the author. */
  response: string;
  outcome: "addressed" | "needs-user";
  blockIds: string[];
}

export interface RevisionParagraph { blockId: string; before: string; after: string }

export interface RevisionEntry {
  id: string;
  createdAt: number;
  kind: "comment" | "coordinated";
  label: string;
  /** Suggestion id shared by the change set; absent for direct edits. */
  changeSetId?: number;
  status: RevisionStatus;
  decidedAt?: number;
  level?: EditLevel;
  summary: string;
  items: RevisionItem[];
  paragraphs: RevisionParagraph[];
  references?: Array<{ citekey: string; title: string; doi: string }>;
}

const MAX_TEXT = 2_000;

function clip(text: string) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

export function recordRevision(map: Y.Map<RevisionEntry>, entry: Omit<RevisionEntry, "id">) {
  const id = `rev-${entry.createdAt}-${Math.random().toString(36).slice(2, 8)}`;
  map.set(id, {
    ...entry, id,
    paragraphs: entry.paragraphs.map(paragraph => ({ ...paragraph, before: clip(paragraph.before), after: clip(paragraph.after) })),
    items: entry.items.map(item => ({ ...item, comment: clip(item.comment), response: clip(item.response) })),
  });
  return id;
}

export function readRevisions(map: Y.Map<RevisionEntry>) {
  return [...map.values()].filter(entry => entry && typeof entry === "object" && typeof entry.id === "string")
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Called when the author settles a change set; never rewrites an already decided entry. */
export function settleRevision(map: Y.Map<RevisionEntry>, changeSetId: string | number, status: Exclude<RevisionStatus, "pending" | "applied">, at: number) {
  for (const entry of map.values()) {
    if (entry.changeSetId === undefined || String(entry.changeSetId) !== String(changeSetId) || entry.status !== "pending") continue;
    map.set(entry.id, { ...entry, status, decidedAt: at });
  }
}

const STATUS_TEXT: Record<RevisionStatus, string> = {
  pending: "Proposed, awaiting the author's decision",
  accepted: "Accepted",
  rejected: "Rejected by the author",
  partial: "Partly accepted",
  applied: "Applied directly",
};

function quoteBlock(text: string) {
  return text.split("\n").map(line => `> ${line}`).join("\n");
}

/**
 * A response-to-reviewers letter from the revision log: each comment with
 * the response and the revised text. Rejected revisions are left out; open
 * questions are listed separately so nothing is claimed as done.
 */
export function buildResponseLetter(entries: RevisionEntry[], documentName: string, options: { includePending?: boolean } = {}) {
  const usable = [...entries].filter(entry => entry.status !== "rejected" && (options.includePending || entry.status !== "pending"))
    .sort((a, b) => a.createdAt - b.createdAt);
  const addressed: Array<{ entry: RevisionEntry; item: RevisionItem }> = [];
  const open: Array<{ entry: RevisionEntry; item: RevisionItem }> = [];
  const seen = new Set<string>();
  // The latest answer to a comment wins.
  for (const entry of [...usable].reverse()) for (const item of entry.items) {
    if (seen.has(item.threadId)) continue;
    seen.add(item.threadId);
    (item.outcome === "addressed" ? addressed : open).unshift({ entry, item });
  }
  const title = documentName.replace(/\.scholarpen\.json$/, "");
  const lines = [`# Response to reviewers: ${title}`, "",
    "We thank the reviewers for their comments. Each comment is followed by our response and the revised text.", ""];
  addressed.forEach(({ entry, item }, index) => {
    lines.push(`## Comment ${index + 1}`, "", quoteBlock(item.comment), "", `**Response.** ${item.response}`, "");
    const changed = entry.paragraphs.filter(paragraph => item.blockIds.includes(paragraph.blockId));
    if (changed.length) {
      lines.push("**Revised text.**", "");
      for (const paragraph of changed) lines.push(quoteBlock(paragraph.after), "");
    }
    if (entry.references?.length) lines.push(`**References added.** ${entry.references.map(ref => `${ref.title} (doi:${ref.doi})`).join("; ")}`, "");
    lines.push(`*Status: ${STATUS_TEXT[entry.status]}.*`, "");
  });
  if (open.length) {
    lines.push("## Comments still open", "");
    for (const { item } of open) lines.push(quoteBlock(item.comment), "", `*Open question:* ${item.response}`, "");
  }
  if (!addressed.length && !open.length) lines.push("No accepted revisions are recorded for this document yet.", "");
  return { markdown: lines.join("\n"), addressed: addressed.length, open: open.length };
}
