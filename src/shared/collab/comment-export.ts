import type { ThreadSnapshot } from "./threads";
import { personaByUser } from "./personas";
import { reviewCategoryLabel } from "./review";

export interface CommentExportEntry {
  thread: ThreadSnapshot;
  position?: number;
  reference?: string | null;
}

// Comment bodies are plain text. Escape Markdown so their headings, HTML and
// image syntax cannot change the report structure or trigger image bundling.
function escapeMarkdown(text: string) {
  return text.replace(/\\/g, "\\\\").replace(/[\[\]*_`#!|]/g, "\\$&")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function quote(text: string) {
  return escapeMarkdown(text).split(/\r?\n/).map(line => `> ${line}`).join("\n");
}
function date(value: number) {
  return Number.isFinite(value) ? new Date(value).toISOString() : "Unknown";
}

/** A complete snapshot, independent of the Activity panel's current filter. */
export function exportUnresolvedComments(params: {
  documentName: string;
  entries: CommentExportEntry[];
  exportedAt?: Date;
}) {
  const entries = params.entries.filter(({ thread }) =>
    !thread.resolved && thread.meta.status !== "resolved" && thread.comments.some(comment => !comment.deleted))
    .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.thread.createdAt - b.thread.createdAt);
  const title = params.documentName.replace(/\.scholarpen\.json$/, "");
  const lines = [
    `# Unresolved comments — ${escapeMarkdown(title)}`,
    "", `- Document: ${escapeMarkdown(params.documentName)}`,
    `- Exported: ${(params.exportedAt ?? new Date()).toISOString()}`,
    `- Unresolved threads: ${entries.length}`,
    "", "Snapshot of all unresolved threads in this document, in manuscript order. Exporting does not resolve or change comments.",
  ];
  for (const [index, { thread, reference }] of entries.entries()) {
    const status = { open: "Open", "in-progress": "AI working", proposed: "Proposed", resolved: "Resolved" }[thread.meta.status ?? "open"];
    lines.push("", `## ${index + 1}. ${thread.meta.category ? escapeMarkdown(reviewCategoryLabel(thread.meta.category)) : "Comment"}`,
      "", `- Status: ${status}`,
      `- Thread ID: ${escapeMarkdown(thread.id)}`);
    if (thread.meta.severity) lines.push(`- Severity: ${thread.meta.severity}`);
    if (thread.meta.statusNote) lines.push(`- Note: ${escapeMarkdown(thread.meta.statusNote).replace(/\n/g, " ")}`);
    lines.push("", "### Referenced passage", "",
      thread.meta.scope === "document" ? "Whole manuscript."
        : reference ? quote(reference) : "The original passage is no longer available (unanchored comment).",
      "", "### Conversation");
    for (const comment of thread.comments.filter(comment => !comment.deleted)) {
      const author = personaByUser(comment.userId)?.name ?? (comment.userId === "me" ? "You" : comment.userId);
      lines.push("", `**${escapeMarkdown(author)}** · ${date(comment.createdAt)}`, "", quote(comment.text));
    }
  }
  return { markdown: `${lines.join("\n")}\n`, count: entries.length };
}

export function unresolvedCommentsFilename(documentName: string, now = new Date()) {
  const name = documentName.replace(/\.scholarpen\.json$/, "").replace(/[\/\\:\x00-\x1f]/g, "-");
  return `${name}-unresolved-comments-${now.toISOString().replace(/[:.]/g, "-")}.md`;
}
